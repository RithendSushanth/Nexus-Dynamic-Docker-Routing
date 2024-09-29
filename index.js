const http = require('http');
const express = require('express');
const httpProxy = require('http-proxy');
const Docker = require('dockerode');

// Initialize Docker and HTTP Proxy
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
const db = new Map();

// Error handling for the proxy
proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Bad gateway.');
});

// Listen to Docker events
docker.getEvents((err, stream) => {
    if (err) {
        console.error('Error in getting events:', err);
        return;
    }

    stream.on('data', async (chunk) => {
        if (!chunk) return;

        try {
            const event = JSON.parse(chunk.toString());

            // Log the entire event for debugging
            // console.log("Event received:", event);

            if (event.Type === 'container' && event.Action === 'start') {
                const containerId = event.Actor.ID; // Use `Actor.ID` for container ID
                if (!containerId) {
                    console.warn("Container ID is undefined. Event data:", event);
                    return;
                }

                try {
                    const container = docker.getContainer(containerId);
                    const containerInfo = await container.inspect();
                    console.log(`Container ${containerInfo.Name} started`);

                    const containerName = containerInfo.Name.startsWith('/') ? containerInfo.Name.slice(1) : containerInfo.Name;
                    const networks = containerInfo.NetworkSettings.Networks;
                    let ipAddress = null;

                    // Extract IP address from the first network
                    if (networks) {
                        const firstNetwork = Object.values(networks)[0];
                        if (firstNetwork && firstNetwork.IPAddress) {
                            ipAddress = firstNetwork.IPAddress;
                        }
                    }

                    if (!ipAddress) {
                        console.error(`Could not determine IP address for container ${containerName}`);
                        return;
                    }

                    // Extract exposed ports
                    const exposedPorts = containerInfo.Config.ExposedPorts || {};
                    let defaultPort = null;

                    // Prioritize standard HTTP port 80 if available
                    if (exposedPorts['80/tcp']) {
                        defaultPort = 80;
                    } else {
                        // Otherwise, take the first exposed TCP port
                        const portKey = Object.keys(exposedPorts).find(port => port.endsWith('/tcp'));
                        if (portKey) {
                            defaultPort = parseInt(portKey.split('/')[0], 10);
                        }
                    }

                    if (!defaultPort) {
                        console.error(`No default TCP port found for container ${containerName}`);
                        return;
                    }

                    const target = `http://${ipAddress}:${defaultPort}`;
                    console.log(`\x1b[32mRegistering container \x1b[33m${containerName}.localhost\x1b[0m \x1b[32mwith IP \x1b[33m${ipAddress}\x1b[0m \x1b[32mand default port \x1b[33m${defaultPort}\x1b[0m ---> \x1b[36m${target}\x1b[0m`);

                    // console.log(`Registering container ${containerName}.localhost with IP ${ipAddress} and default port ${defaultPort} ---> ${target}`);
                    db.set(containerName, { containerName, ipAddress, defaultPort, target });

                    // Optionally, log current mappings
                    console.log("Current container mappings:", [...db.entries()]);
                } catch (inspectErr) {
                    console.error(`Error inspecting container ${containerId}:`, inspectErr);
                }
            }
        } catch (parseError) {
            console.error("Error parsing event data:", parseError);
        }
    });
});

// Reverse Proxy to forward requests to respective containers
const reverseProxyApp = express();

reverseProxyApp.use((req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];

    console.log(`Received request for hostname: ${hostname}, subdomain: ${subdomain}`);

    if (!db.has(subdomain)) {
        return res.status(404).json({
            status: 'error',
            message: 'Container not found',
        });
    }

    const { target } = db.get(subdomain);

    if (!target) {
        console.error(`Invalid target for container ${subdomain}`);
        return res.status(500).json({
            status: 'error',
            message: 'Invalid target configuration',
        });
    }

    console.log(`Forwarding request to ${target}`);

    // Proxy the request using the existing proxy instance
    proxy.web(req, res, { target }, (err) => {
        console.error('Proxy web error:', err.message);
        res.status(502).send('Bad gateway.');
    });
});

// Create HTTP server for reverse proxy
const reverseProxyServer = http.createServer(reverseProxyApp);

// Handle WebSocket upgrades
reverseProxyServer.on('upgrade', (req, socket, head) => {
    const hostname = req.headers.host;
    if (!hostname) {
        console.warn('Upgrade request without hostname');
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
    }

    const subdomain = hostname.split('.')[0];
    console.log(`WebSocket upgrade request for subdomain: ${subdomain}`);

    if (!db.has(subdomain)) {
        console.warn(`Container not found for subdomain: ${subdomain}`);
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
    }

    const { target } = db.get(subdomain);

    if (!target) {
        console.error(`Invalid target for container ${subdomain}`);
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
    }

    console.log(`Upgrading WebSocket connection to ${target}`);

    // Proxy the WebSocket request using the existing proxy instance
    proxy.ws(req, socket, head, { target }, (err) => {
        console.error('Proxy WebSocket error:', err.message);
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
});

// Start the reverse proxy server
reverseProxyServer.listen(80, () => {
    console.log('Reverse proxy running on port 80');
});



// Management API to manage containers
const managementAPI = express();
managementAPI.use(express.json());

managementAPI.post('/container', async (req, res) => {
    const { image, tag } = req.body;
    let imageAlreadyExists = false;

    try {
        const images = await docker.listImages({ all: true });

        for (const systemImage of images) {
            if (!systemImage.RepoTags) continue;
            for (const systemTag of systemImage.RepoTags) {
                if (systemTag === `${image}:${tag}`) {
                    imageAlreadyExists = true;
                    break;
                }
            }
            if (imageAlreadyExists) break;
        }

        if (!imageAlreadyExists) {
            console.log(`Pulling image: ${image}:${tag}`);
            await new Promise((resolve, reject) => {
                docker.pull(`${image}:${tag}`, (pullErr, stream) => {
                    if (pullErr) {
                        return reject(pullErr);
                    }
                    docker.modem.followProgress(stream, (pullErr) => {
                        if (pullErr) {
                            return reject(pullErr);
                        }
                        resolve();
                    });
                });
            });
            console.log(`Image ${image}:${tag} pulled successfully`);
        } else {
            console.log(`Image ${image}:${tag} already exists`);
        }

        const container = await docker.createContainer({
            Image: `${image}:${tag}`,
            Tty: false,
            HostConfig: {
                AutoRemove: true,
            }
        });

        await container.start();
        const containerInfo = await container.inspect();

        const containerName = containerInfo.Name.startsWith('/') ? containerInfo.Name.slice(1) : containerInfo.Name;
        const target = `${containerName}.localhost`;

        return res.json({
            status: 'success',
            message: 'Container started',
            container: target,
        });
    } catch (err) {
        console.error("Error managing container:", err);
        return res.status(500).json({
            status: 'error',
            message: 'Error starting container',
        });
    }
});

// Start the Management API server
managementAPI.listen(8080, () => {
    console.log('Management API listening on port 8080');
});

const mongoose = require('mongoose');

const ContainerSchema = new mongoose.Schema({
  containerName: {
    type: String,
    required: true,
    unique: true
  },
  ipAddress: {
    type: String,
    required: true
  },
  defaultPort: {
    type: Number,
    required: true
  },
  target: {
    type: String,
    required: true
  },
  image: {
    type: String,
    required: true
  },
  tag: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['running', 'stopped', 'error'],
    default: 'running'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Add any pre-save hooks, virtual properties, or methods here if needed
ContainerSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const Container = mongoose.model('Container', ContainerSchema);

module.exports = Container;
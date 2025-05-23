const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load env vars
dotenv.config();

// Global connection cache - reuse connections between function invocations
let cachedDb = null;

// Connect to MongoDB
const connectToDatabase = async () => {
  // If we have a cached connection, verify it's still connected and return it
  if (cachedDb && cachedDb.serverConfig && cachedDb.serverConfig.isConnected()) {
    console.log('=> Using cached database connection');
    return cachedDb;
  }

  console.log('=> Creating new database connection');
  try {
    // Connect with retry logic
    const maxRetries = 3;
    let retries = 0;
    let lastError;

    while (retries < maxRetries) {
      try {
        const client = await mongoose.connect(process.env.MONGODB_URI, {
          serverSelectionTimeoutMS: 3000, // Reduced timeout from 5s to 3s
          socketTimeoutMS: 30000, // Reduced timeout from 45s to 30s
          maxIdleTimeMS: 60000, // Reduced from 120s to 60s for faster connection cycling
          maxPoolSize: 5, // Reduced pool size for serverless environment
          minPoolSize: 1,
          connectTimeoutMS: 5000, // Add connection timeout
        });
        
        console.log('Connected to MongoDB');
        
        // Cache the database connection
        cachedDb = mongoose.connection.db;
        
        // Setup event handlers for the connection
        mongoose.connection.on('error', (err) => {
          console.error('MongoDB connection error:', err);
        });
        
        mongoose.connection.on('disconnected', () => {
          console.log('MongoDB disconnected, will reconnect if needed');
          cachedDb = null;
        });
        
        return cachedDb;
      } catch (err) {
        lastError = err;
        retries++;
        console.log(`MongoDB connection attempt ${retries} failed: ${err.message}`);
        // Add exponential backoff delay between retries
        if (retries < maxRetries) {
          const delay = Math.pow(2, retries) * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    console.error(`Failed to connect to MongoDB after ${maxRetries} attempts:`, lastError);
    throw lastError;
  } catch (err) {
    console.error('Error connecting to database:', err);
    throw err;
  }
};

// Route files
const authRoutes = require('./routes/auth');
const healthRoutes = require('./routes/health');
const recipeRoutes = require('./routes/recipes');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');

// Initialize express app
const app = express();

// Body parser with increased limits for image uploads
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// CORS middleware wrapper function
const allowCors = fn => async (req, res, next) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', process.env.NODE_ENV === 'production' ? 'https://recipedium.vercel.app' : 'http://localhost:3000');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Continue with the next middleware
  return fn(req, res, next);
};

// Apply the CORS middleware to all routes
app.use(allowCors((req, res, next) => next()));

// Dev logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Add timeout middleware to prevent hanging requests
app.use((req, res, next) => {
  // Set a timeout for all requests (8 seconds)
  res.setTimeout(8000, () => {
    console.log('Request has timed out');
    res.status(503).json({
      success: false,
      message: 'Request timeout - operation took too long'
    });
  });
  next();
});

// Mount routers with error handling for database connection
const mountRoutesWithErrorHandling = (app, route, router) => {
  app.use(route, async (req, res, next) => {
    try {
      // Ensure DB is connected for each request
      await connectToDatabase();
      router(req, res, next);
    } catch (error) {
      console.error(`Error connecting to MongoDB: ${error.message}`);
      return res.status(503).json({
        success: false,
        message: 'Database service temporarily unavailable',
      });
    }
  });
};

// Mount routers with connection error handling
mountRoutesWithErrorHandling(app, '/api/auth', authRoutes);
mountRoutesWithErrorHandling(app, '/api/health', healthRoutes);
mountRoutesWithErrorHandling(app, '/api/recipes', recipeRoutes);
mountRoutesWithErrorHandling(app, '/api/users', userRoutes);
mountRoutesWithErrorHandling(app, '/api/admin', adminRoutes);

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  res.status(500).json({
    success: false,
    message: 'Server Error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 5000;

// Update your app.listen to connect to the database first
const startServer = async () => {
  try {
    await connectToDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
  }
};

// Don't auto-start the server when running in serverless environment
if (process.env.NODE_ENV !== 'serverless') {
  startServer();
}

// Export the serverless handler function for Vercel
module.exports = app;

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.log(`Error: ${err.message}`);
  // Log error but continue running in serverless environment
  console.error('Unhandled Rejection:', err);
});
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const router = require('./routes/index');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const logger = require('./config/logger');
const { connectRedis } = require('./config/redis');

const app = express();

// Trust proxy (required for Render, Railway, Vercel, etc.)
app.set('trust proxy', 1);

// Connect to Redis
connectRedis();

// ─── CORS Configuration ──────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'https://pacific-sunday.vercel.app',
  'https://pacific-sunday-admin.vercel.app',
  'http://47.129.165.80:3012',
  'http://47.129.165.80:3010'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // In development, allow all localhost origins
    if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// ─── Static Files ────────────────────────────────────────────────────────────
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
}, express.static(path.join(__dirname, '../uploads')));

// ─── Body Parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Security Headers ────────────────────────────────────────────────────────
// Disable the X-Powered-By header to avoid leaking stack info
app.disable('x-powered-by');

// ─── Request Logger ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api', router);

// Make io instance available to routes (set in server.js after socket init)
app.set('io', null);

// ─── Error Handling ──────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;

import express from 'express';
import cors from 'cors';
import cinetpayRoutes from './routes/cinetpay.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware CORS pour production
const allowedOrigins = [
  'https://jeepal.com', 
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    // En production, autoriser toutes les origins ou spécifiques
    if (process.env.NODE_ENV === 'production') {
      return callback(null, true);
    }
    
    // En développement, vérifier les origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/cinetpay', cinetpayRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Live Shopping Backend - Render',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    node: process.version
  });
});

// Route racine
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Live Shopping Backend API - Deployed on Render',
    status: 'operational',
    endpoints: {
      health: '/api/health',
      webhook: 'POST /api/cinetpay/webhook'
    }
  });
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('💥 Erreur serveur:', err);
  res.status(500).json({ 
    error: 'Erreur interne du serveur',
    ...(process.env.NODE_ENV === 'development' && { details: err.message })
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🏠 Host: 0.0.0.0`);
});
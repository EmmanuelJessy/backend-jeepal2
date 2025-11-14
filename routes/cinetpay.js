import express from 'express';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase.js';

const router = express.Router();

// Webhook CinetPay - VERSION COMPLÈTE
router.post('/webhook', async (req, res) => {
  try {
    const notification = req.body;
    console.log('🔔 Webhook CinetPay reçu:', JSON.stringify(notification, null, 2));

    const { 
      transaction_id, 
      cpm_result, 
      cpm_amount, 
      cpm_currency,
      cpm_trans_id,
      signature,
      payment_method
    } = notification;

    // 🎯 1. VALIDATION DE BASE
    if (!transaction_id && !cpm_trans_id) {
      console.error('❌ Transaction ID manquant');
      return res.status(400).json({ 
        error: 'Transaction ID manquant',
        code: 'MISSING_TRANSACTION_ID'
      });
    }

    const transactionId = transaction_id || cpm_trans_id;
    console.log(`🔍 Traitement transaction: ${transactionId}, Statut: ${cpm_result}`);

    // 🎯 2. RÉPONSE IMMÉDIATE POUR ÉVITER LES TIMEOUT CINETPAY
    res.status(200).json({ 
      status: 'RECEIVED',
      message: 'Webhook traité avec succès',
      transaction_id: transactionId,
      timestamp: new Date().toISOString()
    });

    // 🎯 3. TRAITEMENT ASYNCHRONE (après avoir répondu à CinetPay)
    processWebhookAsync(notification, transactionId, cpm_result);

  } catch (error) {
    console.error('💥 Erreur webhook:', error);
    
    // 🎯 RÉPONSE D'ERREUR STRUCTURÉE
    res.status(500).json({ 
      error: 'Internal server error',
      code: 'SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Erreur serveur' : error.message
    });
  }
});

// 🎯 FONCTION DE TRAITEMENT ASYNCHRONE
async function processWebhookAsync(notification, transactionId, cpm_result) {
  try {
    // 🎯 4. GESTION DE TOUS LES STATUTS CINETPAY
    const statusMapping = {
      '00': { status: 'completed', paymentStatus: 'success' },
      '01': { status: 'pending', paymentStatus: 'pending_validation' },
      '02': { status: 'pending', paymentStatus: 'pending_verification' },
      '03': { status: 'failed', paymentStatus: 'expired' },
      '04': { status: 'failed', paymentStatus: 'canceled' },
      '05': { status: 'failed', paymentStatus: 'rejected' },
      '06': { status: 'failed', paymentStatus: 'insufficient_funds' },
      '07': { status: 'failed', paymentStatus: 'invalid_account' },
      '08': { status: 'failed', paymentStatus: 'technical_error' }
    };

    const statusConfig = statusMapping[cpm_result] || { 
      status: 'unknown', 
      paymentStatus: 'unknown_status' 
    };

    console.log(`📊 Statut détecté: ${cpm_result} -> ${statusConfig.status}`);

    // 🎯 5. VÉRIFICATION/CRÉATION DU PAIEMENT
    const paymentRef = doc(db, 'payments', `pay_${transactionId}`);
    const paymentSnap = await getDoc(paymentRef);

    let paymentData = {};
    
    if (!paymentSnap.exists()) {
      console.log('📝 Création nouvel enregistrement de paiement');
      paymentData = await createPaymentRecord(transactionId, notification, statusConfig);
    } else {
      console.log('📄 Mise à jour paiement existant');
      paymentData = await updatePaymentRecord(paymentSnap.data(), transactionId, notification, statusConfig);
    }

    // 🎯 6. MISE À JOUR SELLER SI PAIEMENT RÉUSSI
    if (statusConfig.status === 'completed' && paymentData.sellerId) {
      await updateSellerPremiumStatus(paymentData, transactionId);
    }

    console.log(`✅ Webhook traité: ${transactionId} -> ${statusConfig.status}`);

  } catch (error) {
    console.error('💥 Erreur traitement asynchrone:', error);
    // Log supplémentaire pour le debugging
  }
}

// 🎯 CRÉATION D'UN NOUVEAU PAIEMENT
async function createPaymentRecord(transactionId, notification, statusConfig) {
  const paymentRef = doc(db, 'payments', `pay_${transactionId}`);
  
  const paymentData = {
    id: `pay_${transactionId}`,
    transactionId: transactionId,
    status: statusConfig.status,
    paymentStatus: statusConfig.paymentStatus,
    amount: parseInt(notification.cpm_amount) || 0,
    currency: notification.cpm_currency || 'XOF',
    paymentMethod: notification.payment_method || 'unknown',
    cinetpayWebhookData: notification,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    [statusConfig.status === 'completed' ? 'completedAt' : 
     statusConfig.status === 'failed' ? 'failedAt' : 'updatedAt']: serverTimestamp()
  };

  await setDoc(paymentRef, paymentData);
  console.log('📝 Nouveau paiement créé:', paymentData.status);
  return paymentData;
}

// 🎯 MISE À JOUR PAIEMENT EXISTANT
async function updatePaymentRecord(existingData, transactionId, notification, statusConfig) {
  const paymentRef = doc(db, 'payments', `pay_${transactionId}`);
  
  const updateData = {
    status: statusConfig.status,
    paymentStatus: statusConfig.paymentStatus,
    cinetpayWebhookData: notification,
    updatedAt: serverTimestamp(),
    [statusConfig.status === 'completed' ? 'completedAt' : 
     statusConfig.status === 'failed' ? 'failedAt' : 'updatedAt']: serverTimestamp()
  };

  await setDoc(paymentRef, updateData, { merge: true });
  console.log('📄 Paiement mis à jour:', statusConfig.status);
  return { ...existingData, ...updateData };
}

// 🎯 MISE À JOUR STATUT SELLER (inchangé)
async function updateSellerPremiumStatus(paymentData, transactionId) {
  if (!paymentData.sellerId) return;

  const sellerRef = doc(db, 'sellers', paymentData.sellerId);
  const expiryDate = calculateExpiryDate(paymentData.planType);
  
  await setDoc(sellerRef, {
    isPremium: true,
    premiumUntil: expiryDate,
    currentPlan: paymentData.planType,
    planStartedAt: serverTimestamp(),
    lastPayment: {
      amount: paymentData.amount,
      date: serverTimestamp(),
      transactionId: transactionId
    },
    updatedAt: serverTimestamp()
  }, { merge: true });
  
  console.log('✅ Statut seller mis à jour');
}

function calculateExpiryDate(planType) {
  const now = new Date();
  const durations = { 
    monthly: 1, 
    semiannual: 6, 
    annual: 12 
  };
  const months = durations[planType] || 1;
  const expiryDate = new Date(now.setMonth(now.getMonth() + months));
  console.log(`📅 Date d'expiration calculée: ${expiryDate}`);
  return expiryDate;
}

// 🎯 ROUTE DE TEST POUR CINETPAY
router.get('/test', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Webhook CinetPay opérationnel',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: 'POST /api/cinetpay/webhook',
      health: 'GET /api/cinetpay/test'
    }
  });
});

// 🎯 ROUTE PING (pour vérification)
router.post('/ping', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Pong! Webhook accessible',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

export default router;
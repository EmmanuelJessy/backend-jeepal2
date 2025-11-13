import express from 'express';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase.js';

const router = express.Router();

// Webhook CinetPay
router.post('/webhook', async (req, res) => {
  try {
    const notification = req.body;
    console.log('🔔 Webhook CinetPay reçu:', JSON.stringify(notification, null, 2));

    const { transaction_id, cpm_result, cpm_amount, cpm_currency } = notification;

    if (!transaction_id) {
      return res.status(400).json({ error: 'Transaction ID manquant' });
    }

    console.log(`🔍 Traitement transaction: ${transaction_id}, Statut: ${cpm_result}`);

    // Vérifier si le paiement existe
    const paymentRef = doc(db, 'payments', `pay_${transaction_id}`);
    const paymentSnap = await getDoc(paymentRef);

    if (!paymentSnap.exists()) {
      console.error('❌ Paiement non trouvé dans Firestore:', transaction_id);
      
      // Créer un enregistrement même si non trouvé (fallback)
      const fallbackData = {
        id: `pay_${transaction_id}`,
        transactionId: transaction_id,
        status: cpm_result === '00' ? 'completed' : 'failed',
        paymentStatus: cpm_result === '00' ? 'success' : 'webhook_failed',
        amount: parseInt(cpm_amount) || 0,
        currency: cpm_currency || 'XOF',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        cinetpayWebhookData: notification,
        [cpm_result === '00' ? 'completedAt' : 'failedAt']: serverTimestamp()
      };
      
      await setDoc(paymentRef, fallbackData);
      console.log('📝 Enregistrement fallback créé dans Firestore');
      
      return res.status(200).json({ status: 'OK', created: true });
    }

    const paymentData = paymentSnap.data();
    console.log('📄 Paiement trouvé:', paymentData.status);
    
    if (cpm_result === '00') {
      // ✅ Paiement réussi
      console.log('✅ Paiement confirmé via webhook');
      
      const updateData = {
        status: 'completed',
        paymentStatus: 'success',
        completedAt: serverTimestamp(),
        cinetpayWebhookData: notification,
        updatedAt: serverTimestamp()
      };

      // Mettre à jour le statut du paiement
      await setDoc(paymentRef, updateData, { merge: true });

      // Mettre à jour le statut du seller
      if (paymentData.sellerId) {
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
            transactionId: transaction_id
          },
          updatedAt: serverTimestamp()
        }, { merge: true });
        
        console.log('✅ Statut seller mis à jour dans Firestore');
      }

    } else {
      // ❌ Paiement échoué
      console.log('❌ Paiement échoué via webhook');
      
      await setDoc(paymentRef, {
        status: 'failed',
        paymentStatus: 'webhook_failed',
        failedAt: serverTimestamp(),
        cinetpayWebhookData: notification,
        errorMessage: notification.cpm_error_message || `Échec: ${cpm_result}`,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }

    res.status(200).json({ status: 'OK' });
    
  } catch (error) {
    console.error('💥 Erreur webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

export default router;
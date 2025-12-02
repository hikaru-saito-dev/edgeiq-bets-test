import { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import crypto from 'crypto';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('WHOP_WEBHOOK_SECRET environment variable is required');
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface WhopWebhookPayload {
  data: {
    id: string;
    user_id: string;
    plan_id: string;
    company_id: string;
    status: string;
    metadata?: {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number | string;
    };
  };
  api_version: string;
  action: string;
}

/**
 * Verify Whop webhook signature
 * Format: x-whop-signature: t=timestamp,v1=signature
 */
function verifyWhopSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    // Parse signature: t=timestamp,v1=signature
    const parts = signature.split(',');
    const timestampPart = parts.find((p) => p.startsWith('t='));
    const signaturePart = parts.find((p) => p.startsWith('v1='));

    if (!timestampPart || !signaturePart) {
      return false;
    }

    const timestamp = timestampPart.split('=')[1];
    const receivedSignature = signaturePart.split('=')[1];

    // Create signed payload: timestamp.payload
    const signedPayload = `${timestamp}.${payload}`;

    // Compute HMAC SHA256
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signedPayload);
    const computedSignature = hmac.digest('hex');

    // Compare signatures using timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(receivedSignature, 'hex'),
      Buffer.from(computedSignature, 'hex')
    );
  } catch (error) {
    return false;
  }
}

/**
 * Webhook handler for Whop payment events
 * Handles app-level webhooks with x-whop-signature header
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Get raw request body as text (required for signature verification)
    const requestBodyText = await request.text();

    if (!requestBodyText || requestBodyText.length === 0) {
      return new Response('Empty request body', { status: 400 });
    }

    // Get signature header
    const signature = request.headers.get('x-whop-signature');

    if (!signature) {
      return new Response('Missing x-whop-signature header', { status: 401 });
    }

    // Verify webhook signature
    const isValidSignature = verifyWhopSignature(
      requestBodyText,
      signature,
      WEBHOOK_SECRET || ''
    );

    if (!isValidSignature) {
      return new Response('Invalid webhook signature', { status: 401 });
    }

    // Parse webhook payload
    let webhookPayload: WhopWebhookPayload;
    try {
      webhookPayload = JSON.parse(requestBodyText) as WhopWebhookPayload;
    } catch (error) {
      return new Response('Invalid JSON payload', { status: 400 });
    }

    // Handle app_payment.succeeded events
    if (webhookPayload.action === 'app_payment.succeeded') {
      waitUntil(handlePaymentSucceeded(webhookPayload.data));
    }

    // Return 200 OK quickly to prevent webhook retries
    return new Response('OK', { status: 200 });
  } catch (error) {
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Process payment succeeded webhook
 * Runs asynchronously via waitUntil to avoid blocking the response
 */
async function handlePaymentSucceeded(paymentData: WhopWebhookPayload['data']): Promise<void> {
  try {
    await connectDB();

    const planId = paymentData.plan_id;
    if (!planId) {
      return;
    }

    // Only process paid payments
    if (paymentData.status !== 'paid') {
      return;
    }

    // Extract metadata from payment data
    const metadata = paymentData.metadata || {};

    // Only process follow purchase webhooks
    if (!metadata.followPurchase) {
      return;
    }

    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || paymentData.company_id;
    // Handle numPlays as either number or string
    const numPlaysRaw =
      typeof metadata.numPlays === 'string'
        ? parseInt(metadata.numPlays, 10)
        : metadata.numPlays;
    
    // Ensure numPlays is a valid positive number
    const numPlays = numPlaysRaw && numPlaysRaw > 0 ? numPlaysRaw : 10;
    const followerWhopUserId = paymentData.user_id;
    const paymentId = paymentData.id;

    // Validate required fields
    if (!capperUserId || !capperCompanyId || !followerWhopUserId || !paymentId) {
      return;
    }

    // Check if we already processed this payment (prevent duplicates)
    const existingPurchase = await FollowPurchase.findOne({
      paymentId: paymentId,
    });

    if (existingPurchase) {
      return;
    }

    // Find the follower user (the person who purchased)
    // Search by whopUserId only - follower might be in a different company
    // Try to find any user record with this whopUserId
    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
    });

    // If not found, the user might not exist yet (they should exist if they logged in)
    // For now, we'll return silently - in the future we might want to create them
    if (!followerUser || !followerUser.whopUserId) {
      return;
    }

    // Find the capper (content creator being followed)
    const capperUser = await User.findById(capperUserId);

    if (!capperUser || !capperUser.whopUserId) {
      return;
    }

    // Verify plan ID matches the capper's current follow offer plan
    if (capperUser.followOfferPlanId !== planId) {
      return;
    }

    // Verify follow offer is still enabled
    if (!capperUser.followOfferEnabled) {
      return;
    }

    // Verify follower is not trying to follow themselves (by whopUserId - person level)
    if (followerUser.whopUserId === capperUser.whopUserId) {
      return;
    }

    // Check if follower already has an active follow purchase for this capper (by whopUserId - person level)
    // This prevents duplicate follows across all companies for the same person
    const existingActiveFollow = await FollowPurchase.findOne({
      followerWhopUserId: followerUser.whopUserId,
      capperWhopUserId: capperUser.whopUserId,
      status: 'active',
    });

    if (existingActiveFollow) {
      return; // Already has an active follow
    }

    // Create follow purchase record
    // Use capperCompanyId for the companyId field (the company being followed)
    const followPurchase = new FollowPurchase({
      followerUserId: followerUser._id,
      capperUserId: capperUser._id,
      followerWhopUserId: followerUser.whopUserId,
      capperWhopUserId: capperUser.whopUserId,
      companyId: capperCompanyId, // Company of the capper being followed
      numPlaysPurchased: numPlays,
      numPlaysConsumed: 0,
      status: 'active',
      planId: planId,
      paymentId: paymentId,
    });

    await followPurchase.save();
  } catch (error) {
    // Silently handle errors in async function
    // Errors are logged but don't affect webhook response
  }
}

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
      project?: string;
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
    console.error('[FollowPurchase] Error verifying webhook signature:', error);
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
    // Strip whsec_ prefix if present (Whop webhook secret format)
    const secret = WEBHOOK_SECRET?.startsWith('whsec_') 
      ? WEBHOOK_SECRET.slice(6) 
      : WEBHOOK_SECRET || '';
    
    const isValidSignature = verifyWhopSignature(
      requestBodyText,
      signature,
      secret
    );

    if (!isValidSignature) {
      return new Response('Invalid webhook signature', { status: 401 });
    }

    // Parse webhook payload
    let webhookPayload: WhopWebhookPayload;
    try {
      webhookPayload = JSON.parse(requestBodyText) as WhopWebhookPayload;
    } catch (error) {
      console.error('[FollowPurchase] Failed to parse webhook payload:', error);
      return new Response('Invalid JSON payload', { status: 400 });
    }

    // Log full webhook payload for debugging
    console.error('[FollowPurchase] Received webhook:', {
      action: webhookPayload.action,
      dataKeys: Object.keys(webhookPayload.data || {}),
      fullPayload: JSON.stringify(webhookPayload, null, 2),
    });

    // Handle payment succeeded events
    // Whop can send either "payment.succeeded" or "app_payment.succeeded"
    if (
      webhookPayload.action === 'payment.succeeded' ||
      webhookPayload.action === 'app_payment.succeeded'
    ) {
      // Process async and capture result for logging
      const resultPromise = handlePaymentSucceeded(webhookPayload.data);
      waitUntil(resultPromise);
      
      // Log immediately for debugging
      console.error('[FollowPurchase] Webhook received - processing async:', {
        paymentId: webhookPayload.data?.id,
        planId: webhookPayload.data?.plan_id,
        action: webhookPayload.action,
      });
    }

    // Return 200 OK quickly to prevent webhook retries
    // Return JSON response for compatibility
    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[FollowPurchase] Error handling webhook:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Process payment succeeded webhook
 * Runs asynchronously via waitUntil to avoid blocking the response
 */
async function handlePaymentSucceeded(paymentData: WhopWebhookPayload['data']): Promise<void> {
  try {
    // Log with console.error so it appears in Vercel logs
    console.error('[FollowPurchase] Starting payment processing:', JSON.stringify({
      paymentId: paymentData.id,
      planId: paymentData.plan_id,
      status: paymentData.status,
      fullPaymentData: paymentData,
    }, null, 2));

    await connectDB();

    const planId = paymentData.plan_id;
    if (!planId) {
      console.error('[FollowPurchase] Missing plan_id in webhook payload');
      return;
    }

    // Only process paid payments
    if (paymentData.status !== 'paid') {
      console.error('[FollowPurchase] Payment status is not paid:', paymentData.status);
      return;
    }

    // Extract metadata from payment data - check both direct metadata and nested locations
    let metadata = paymentData.metadata || {};
    
    // Whop sometimes stores metadata in different locations, check payment object structure
    const paymentObj = paymentData as unknown as {
      metadata?: Record<string, unknown>;
      checkout_configuration?: {
        metadata?: Record<string, unknown>;
      };
    };
    
    if (!metadata || Object.keys(metadata).length === 0) {
      metadata = paymentObj.checkout_configuration?.metadata || {};
    }

    // Log with console.error so it appears in Vercel logs
    console.error('[FollowPurchase] Extracted metadata:', JSON.stringify({
      metadataKeys: Object.keys(metadata),
      metadata: metadata,
      hasFollowPurchase: !!metadata.followPurchase,
    }, null, 2));

    // Only process follow purchase webhooks
    if (!metadata.followPurchase) {
      console.error('[FollowPurchase] Not a follow purchase webhook. Metadata:', JSON.stringify(metadata));
      return;
    }
    const project = metadata.project;
    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || paymentData.company_id;
    if (project !== "Bet") {
      return;
    }
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
      console.error('[FollowPurchase] Missing required fields:', {
        capperUserId: !!capperUserId,
        capperCompanyId: !!capperCompanyId,
        followerWhopUserId: !!followerWhopUserId,
        paymentId: !!paymentId,
        metadata: JSON.stringify(metadata),
      });
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
    if (!followerUser || !followerUser.whopUserId) {
      console.error('[FollowPurchase] Follower user not found:', followerWhopUserId);
      return;
    }

    // Find the capper (content creator being followed)
    const capperUser = await User.findById(capperUserId);

    if (!capperUser || !capperUser.whopUserId) {
      console.error('[FollowPurchase] Capper user not found:', capperUserId);
      return;
    }

    // Note: We use metadata.capperUserId as the primary identifier (already found capper above)
    // Plan ID check is informational only - metadata.capperUserId is the source of truth
    if (capperUser.followOfferPlanId && capperUser.followOfferPlanId !== planId) {
      console.error('[FollowPurchase] Warning - Plan ID mismatch (using metadata.capperUserId as primary):', {
        expected: capperUser.followOfferPlanId,
        received: planId,
        capperUserId: String(capperUser._id),
      });
      // Continue processing - metadata.capperUserId uniquely identifies the capper
    }

    // Verify follow offer is still enabled
    if (!capperUser.followOfferEnabled) {
      console.error('[FollowPurchase] Follow offer not enabled for capper:', String(capperUser._id));
      return;
    }

    // Verify follower is not trying to follow themselves (by whopUserId - person level)
    if (followerUser.whopUserId === capperUser.whopUserId) {
      console.error('[FollowPurchase] User trying to follow themselves:', followerUser.whopUserId);
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
      console.error('[FollowPurchase] Already has active follow:', String(existingActiveFollow._id));
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
    // Log success with console.error so it appears in Vercel logs
    console.error('[FollowPurchase] ✅ SUCCESS - Created follow purchase:', JSON.stringify({
      followPurchaseId: String(followPurchase._id),
      followerWhopUserId: followPurchase.followerWhopUserId,
      capperWhopUserId: followPurchase.capperWhopUserId,
      paymentId: followPurchase.paymentId,
    }, null, 2));
  } catch (error) {
    // Log errors for debugging
    console.error('[FollowPurchase] Error processing payment webhook:', error);
    if (error instanceof Error) {
      console.error('[FollowPurchase] Error message:', error.message);
      console.error('[FollowPurchase] Error stack:', error.stack);
    }
  }
}

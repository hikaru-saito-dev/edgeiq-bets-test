import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';

export const runtime = 'nodejs';

const WHOP_API_KEY = process.env.WHOP_API_KEY || '';
const EDGEIQ_COMPANY_ID = process.env.NEXT_PUBLIC_WHOP_COMPANY_ID || 'biz_G4VyD9ctvjGZ8O'; // EdgeIQ company ID

/**
 * POST /api/follow/checkout
 * Creates a checkout configuration/link for follow offer
 * Called when company owner saves their follow offer settings
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    
    const headers = await import('next/headers').then(m => m.headers());
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { priceCents, numPlays, capperUsername } = body;

    if (!priceCents || !numPlays || !capperUsername) {
      return NextResponse.json(
        { error: 'Missing required fields: priceCents, numPlays, capperUsername' },
        { status: 400 }
      );
    }

    // Find the capper (company owner) - use authenticated user from headers
    const capper = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!capper) {
      return NextResponse.json({ error: 'Capper user not found' }, { status: 404 });
    }

    // Only owners/companyOwners can create follow offers
    if (capper.role !== 'companyOwner' && capper.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only company owners can create follow offers' },
        { status: 403 }
      );
    }

    // Create checkout configuration via Whop API
    const checkoutResponse = await fetch(
      'https://api.whop.com/api/v1/checkout_configurations',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHOP_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan: {
            company_id: EDGEIQ_COMPANY_ID, // EdgeIQ company
            initial_price: priceCents,
            plan_type: 'one_time',
            currency: 'usd',
          },
          metadata: {
            followPurchase: true,
            capperUserId: String(capper._id),
            capperCompanyId: capper.companyId || companyId,
            numPlays: numPlays,
          },
          affiliate_code: capperUsername, // Capper's username for affiliate tracking
          redirect_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://edgeiq-bets.vercel.app'}/following`,
        }),
      }
    );

    if (!checkoutResponse.ok) {
      const errorText = await checkoutResponse.text();
      console.error('Whop checkout creation failed:', errorText);
      return NextResponse.json(
        { error: 'Failed to create checkout link' },
        { status: 500 }
      );
    }

    const checkout = await checkoutResponse.json();
    const planId = checkout.plan?.id;
    const purchaseUrl = checkout.purchase_url;

    if (!planId || !purchaseUrl) {
      return NextResponse.json(
        { error: 'Invalid checkout response from Whop' },
        { status: 500 }
      );
    }

    // Add affiliate param to purchase URL
    const checkoutUrl = new URL(purchaseUrl);
    checkoutUrl.searchParams.set('a', capperUsername);
    const finalCheckoutUrl = checkoutUrl.toString();

    // Update capper's follow offer settings
    capper.followOfferEnabled = true;
    capper.followOfferPriceCents = priceCents;
    capper.followOfferNumPlays = numPlays;
    capper.followOfferPlanId = planId;
    capper.followOfferCheckoutUrl = finalCheckoutUrl;
    await capper.save();

    return NextResponse.json({
      success: true,
      planId: planId,
      checkoutUrl: finalCheckoutUrl,
    });
  } catch (error) {
    console.error('Error creating follow checkout:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


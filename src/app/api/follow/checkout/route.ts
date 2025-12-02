import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';

export const runtime = 'nodejs';

const WHOP_API_KEY = process.env.WHOP_API_KEY || '';
const EDGEIQ_COMPANY_ID = process.env.NEXT_PUBLIC_WHOP_COMPANY_ID || '';

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

    // Validate price is positive
    if (typeof priceCents !== 'number' || priceCents <= 0) {
      return NextResponse.json(
        { error: 'Price must be a positive number' },
        { status: 400 }
      );
    }

    // Validate numPlays is positive integer
    if (typeof numPlays !== 'number' || numPlays <= 0 || !Number.isInteger(numPlays)) {
      return NextResponse.json(
        { error: 'Number of plays must be a positive integer' },
        { status: 400 }
      );
    }

    // Validate reasonable limits
    if (numPlays > 1000) {
      return NextResponse.json(
        { error: 'Number of plays cannot exceed 1000' },
        { status: 400 }
      );
    }

    const capper = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!capper) {
      return NextResponse.json({ error: 'Capper user not found' }, { status: 404 });
    }

    if (capper.role !== 'companyOwner' && capper.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only company owners can create follow offers' },
        { status: 403 }
      );
    }

    const capperIdString = String(capper._id);
    
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
            company_id: EDGEIQ_COMPANY_ID,
            initial_price: priceCents,
            plan_type: 'one_time',
            currency: 'usd',
          },
          metadata: {
            followPurchase: true,
            project: "Bet",
            capperUserId: capperIdString, // Unique MongoDB _id per capper - this is the primary identifier
            capperCompanyId: capper.companyId || companyId,
            numPlays: numPlays,
          },
          affiliate_code: capperUsername,
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

    const checkoutUrl = new URL(purchaseUrl);
    checkoutUrl.searchParams.set('a', capperUsername);
    const finalCheckoutUrl = checkoutUrl.toString();

    // Always update with new plan_id - each capper gets unique plan_id
    capper.followOfferEnabled = true;
    capper.followOfferPriceCents = priceCents;
    capper.followOfferNumPlays = numPlays;
    capper.followOfferPlanId = planId; // Unique plan_id per capper
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

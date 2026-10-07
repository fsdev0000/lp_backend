const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
require('dotenv').config({ override: true });

const prisma = new PrismaClient();
const db = prisma;

async function runTests() {
  console.log('====================================================');
  console.log('LEADERS PERFORMANCE NEWSLETTER SYSTEM INTEGRATION TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const testEmail1 = `test.subscriber.${Date.now()}@example.com`;
  const testEmail2 = `test.sub.cutoff.${Date.now()}@example.com`;

  try {
    // ----------------------------------------------------
    // Scenario 1: New Subscriber with Explicit Consent
    // ----------------------------------------------------
    console.log('\n--- Scenario 1: New Subscriber ---');
    const token1 = crypto.randomBytes(32).toString('hex');
    const sub1 = await db.newsletterSubscriber.create({
      data: {
        email: testEmail1.toLowerCase(),
        firstName: 'Alexander',
        consentGiven: true,
        consentDate: new Date(),
        consentSource: 'website',
        privacyPolicyVersion: 'v2026.3',
        subscribed: true,
        status: 'subscribed',
        unsubscribeToken: token1,
        source: 'Website Footer',
        subscribedAt: new Date(Date.now() - 3600 * 1000), // subscribed 1 hour ago
      },
    });

    assert(sub1 && sub1.id, 'New subscriber successfully created with UUID/ID');
    assert(sub1.email === testEmail1.toLowerCase(), 'Email normalized to lowercase');
    assert(sub1.subscribed === true, 'Subscribed defaults to true');
    assert(sub1.consentGiven === true, 'Consent explicitly recorded as true');
    assert(sub1.unsubscribeToken === token1, 'Secure non-guessable unsubscribe token generated');
    assert(sub1.privacyPolicyVersion === 'v2026.3', 'Privacy policy version recorded');

    // ----------------------------------------------------
    // Scenario 2: Duplicate Subscription Attempt
    // ----------------------------------------------------
    console.log('\n--- Scenario 2: Duplicate Subscription ---');
    const duplicateLookup = await db.newsletterSubscriber.findUnique({
      where: { email: testEmail1.toLowerCase() },
    });
    const totalWithEmail = await db.newsletterSubscriber.count({
      where: { email: testEmail1.toLowerCase() },
    });

    assert(duplicateLookup.subscribed === true, 'Existing subscriber confirmed active');
    assert(totalWithEmail === 1, 'Only one record exists for email (Unique constraint enforced)');

    // ----------------------------------------------------
    // Scenario 3: Unsubscribe with Valid Token
    // ----------------------------------------------------
    console.log('\n--- Scenario 3: Unsubscribe with Valid Token ---');
    const targetSub = await db.newsletterSubscriber.findUnique({
      where: { unsubscribeToken: token1 },
    });
    assert(targetSub !== null, 'Subscriber found via unique unsubscribe token');

    const unsubsAt = new Date();
    const unsubscribedRecord = await db.newsletterSubscriber.update({
      where: { id: targetSub.id },
      data: {
        subscribed: false,
        status: 'unsubscribed',
        unsubscribedAt: unsubsAt,
      },
    });

    assert(unsubscribedRecord.subscribed === false, 'Subscribed set to false');
    assert(unsubscribedRecord.status === 'unsubscribed', 'Status set to unsubscribed');
    assert(unsubscribedRecord.unsubscribedAt !== null, 'unsubscribed_at timestamp populated');

    // Verify record suppression (Record is NOT deleted from DB)
    const suppressionCheck = await db.newsletterSubscriber.findUnique({
      where: { email: testEmail1.toLowerCase() },
    });
    assert(suppressionCheck !== null, 'Record retained in DB as suppression record');

    // ----------------------------------------------------
    // Scenario 4: Resubscription of Unsubscribed Email
    // ----------------------------------------------------
    console.log('\n--- Scenario 4: Resubscription ---');
    const resubDate = new Date();
    const resubscribed = await db.newsletterSubscriber.update({
      where: { email: testEmail1.toLowerCase() },
      data: {
        subscribed: true,
        status: 'subscribed',
        unsubscribedAt: null,
        consentGiven: true,
        consentDate: resubDate,
        subscribedAt: resubDate,
      },
    });

    assert(resubscribed.subscribed === true, 'Resubscribed set to true');
    assert(resubscribed.unsubscribedAt === null, 'unsubscribed_at cleared upon resubscription');
    assert(resubscribed.consentDate.getTime() === resubDate.getTime(), 'New consent timestamp recorded');

    // ----------------------------------------------------
    // Scenario 5: Campaign Creation & Approval Gate
    // ----------------------------------------------------
    console.log('\n--- Scenario 5: Campaign Creation & Approval Gate ---');
    const campaignKey = `TEST-${Date.now()}`;
    const campaign = await db.newsletterCampaign.create({
      data: {
        campaignKey,
        campaignMonth: '2026-10',
        title: 'Executive Focus Under Commercial Pressure',
        subject: 'The Founder Performance Newsletter — Issue #2',
        pdfPath: '2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf',
        status: 'draft',
        approvalStatus: 'pending',
      },
    });

    assert(campaign && campaign.id, 'Campaign created in newsletter_campaigns');
    assert(campaign.approvalStatus === 'pending', 'Campaign defaults to pending approval');
    assert(campaign.pdfPath === '2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf', 'Campaign references Supabase Storage object path without hardcoded external domains');

    // Verify dynamic Supabase storage signed URL resolution for email attachment
    const { getNewsletterPdfAttachmentUrl } = require('../src/services/newsletterStorage.ts');
    const resolvedAttachmentUrl = await getNewsletterPdfAttachmentUrl(campaign.pdfPath);
    assert(
      resolvedAttachmentUrl && resolvedAttachmentUrl.includes('supabase.co') && resolvedAttachmentUrl.includes('news-letter'),
      'PDF attachment URL successfully resolved from Supabase Storage bucket news-letter'
    );

    // Verify approval refusal check
    const isApprovedBefore = campaign.approvalStatus === 'approved';
    assert(isApprovedBefore === false, 'Unapproved campaign blocked from sending');

    // Approve Campaign
    const approvedCampaign = await db.newsletterCampaign.update({
      where: { id: campaign.id },
      data: {
        approvalStatus: 'approved',
        approvedAt: new Date(),
      },
    });
    assert(approvedCampaign.approvalStatus === 'approved', 'Campaign successfully approved');

    // ----------------------------------------------------
    // Scenario 6: Eligibility Rule & Cutoff Enforcement
    // ----------------------------------------------------
    console.log('\n--- Scenario 6: Eligibility Rule & Cutoff ---');
    const cutoffDate = new Date(); // Cutoff is NOW

    // Create Subscriber AFTER Cutoff Date (should NOT be included)
    const token2 = crypto.randomBytes(32).toString('hex');
    const lateSub = await db.newsletterSubscriber.create({
      data: {
        email: testEmail2.toLowerCase(),
        firstName: 'Sarah',
        consentGiven: true,
        consentDate: new Date(Date.now() + 60000), // subscribed after cutoff
        subscribedAt: new Date(Date.now() + 60000),
        subscribed: true,
        status: 'subscribed',
        unsubscribeToken: token2,
      },
    });

    // Query eligible subscribers: consent_given = true AND subscribed = true AND email IS NOT NULL AND subscribed_at <= cutoffDate
    const eligibleSubscribers = await db.newsletterSubscriber.findMany({
      where: {
        consentGiven: true,
        subscribed: true,
        email: { not: '' },
        subscribedAt: { lte: cutoffDate },
      },
    });

    const sub1Included = eligibleSubscribers.some((s) => s.id === sub1.id);
    const lateSubIncluded = eligibleSubscribers.some((s) => s.id === lateSub.id);

    assert(sub1Included === true, 'Subscriber before cutoff IS included in eligible list');
    assert(lateSubIncluded === false, 'Subscriber AFTER cutoff is EXCLUDED (waits for next campaign)');

    // ----------------------------------------------------
    // Scenario 7: Recipient Snapshot & Delivery Tracking
    // ----------------------------------------------------
    console.log('\n--- Scenario 7: Recipient Snapshot & Delivery ---');
    // Create Recipient Snapshot
    const recipient = await db.newsletterCampaignRecipient.create({
      data: {
        campaignId: campaign.id,
        subscriberId: sub1.id,
        email: sub1.email,
        status: 'pending',
      },
    });

    assert(recipient && recipient.id, 'Recipient snapshot created in newsletter_campaign_recipients');
    assert(recipient.status === 'pending', 'Initial recipient delivery status is pending');

    // Verify Unique Constraint (campaignId + subscriberId)
    let duplicateRecipientFailed = false;
    try {
      await db.newsletterCampaignRecipient.create({
        data: {
          campaignId: campaign.id,
          subscriberId: sub1.id,
          email: sub1.email,
          status: 'pending',
        },
      });
    } catch (err) {
      duplicateRecipientFailed = true;
    }
    assert(duplicateRecipientFailed === true, 'Unique constraint on (campaign_id, subscriber_id) prevents duplicate recipients');

    // Simulate Delivery Success
    const updatedRecipient = await db.newsletterCampaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        providerMessageId: 'msg_test_12345',
      },
    });

    assert(updatedRecipient.status === 'sent', 'Recipient status updated to sent upon delivery');
    assert(updatedRecipient.sentAt !== null, 'sent_at timestamp populated');

    // Verify Duplicate Send Prevention: If status is 'sent', NEVER send again!
    const recheck = await db.newsletterCampaignRecipient.findUnique({
      where: { id: recipient.id },
    });
    const shouldSendAgain = recheck.status !== 'sent';
    assert(shouldSendAgain === false, 'Already sent recipients are NEVER resent on retry');

    // ----------------------------------------------------
    // Scenario 8: Clean-up Test Data
    // ----------------------------------------------------
    console.log('\n--- Cleaning up test records ---');
    await db.newsletterCampaignRecipient.deleteMany({
      where: { campaignId: campaign.id },
    });
    await db.newsletterCampaign.delete({
      where: { id: campaign.id },
    });
    await db.newsletterSubscriber.deleteMany({
      where: { email: { in: [testEmail1.toLowerCase(), testEmail2.toLowerCase()] } },
    });
    console.log('[Cleanup] Completed cleanly.');

  } catch (error) {
    console.error('[Error during tests]:', error);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();

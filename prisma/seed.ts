import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

declare const process: any;

const prisma = new PrismaClient();

const defaultQuestions = [
  // 1. Founder Involvement (2 questions)
  { domain: "Founder Involvement", text: "How often does day-to-day progress depend directly on your personal involvement?" },
  { domain: "Founder Involvement", text: "How often does operational momentum pause when you are unavailable or focused elsewhere?" },
  // 2. Decision Load (2 questions)
  { domain: "Decision Load", text: "How often do important operational or strategic decisions wait for your review before work can proceed?" },
  { domain: "Decision Load", text: "How often do decisions that belong at team level get escalated back to you?" },
  // 3. Execution Rhythm (2 questions)
  { domain: "Execution Rhythm", text: "How often do strategic priorities or commitments slip without your repeated follow-up?" },
  { domain: "Execution Rhythm", text: "How often does delivery consistency require founder-level intervention to stay on schedule?" },
  // 4. Leadership Ownership (2 questions)
  { domain: "Leadership Ownership", text: "How often do leaders wait for your explicit direction before taking action on ambiguous challenges?" },
  { domain: "Leadership Ownership", text: "How often do leaders defer consequential accountability back to you instead of resolving outcomes?" },
  // 5. Operational Resilience (2 questions)
  { domain: "Operational Resilience", text: "How often does unexpected operational friction disrupt your organisation's core rhythm?" },
  { domain: "Operational Resilience", text: "How sensitive is current performance when you or key team members are under sustained demand?" },
];

const defaultPressureOptions = [
  { key: "founder_involvement", title: "Progress still depends heavily on my personal involvement", hint: "Execution and decisions slow whenever I am not directly driving them." },
  { key: "decision_load", title: "Too many decisions continue to concentrate around me", hint: "Important operational and strategic approvals create bottlenecks." },
  { key: "execution_rhythm", title: "Execution and commitments slip without repeated intervention", hint: "Priorities lack self-sustaining consistency and momentum." },
  { key: "leadership_ownership", title: "Leaders hesitate to make decisions or take full ownership", hint: "Responsibilities exist, but accountability repeatedly returns to me." },
  { key: "operational_resilience", title: "The organisation struggles when I am unavailable or focused elsewhere", hint: "Operating rhythm experiences strain as complexity increases." },
  { key: "unsure", title: "I am not sure yet", hint: "The scan questions will help clarify where directional pressure is concentrating." },
];

const revenueBands = ["Under €1M", "€1M–€5M", "€5M–€15M", "€15M–€50M", "€50M+"];
const stages = ["Early-stage", "Growth-stage", "Scale-stage", "Mature"];
const scaleOptions = [
  { key: "never", label: "Never", value: 1 },
  { key: "rarely", label: "Rarely", value: 2 },
  { key: "sometimes", label: "Sometimes", value: 3 },
  { key: "often", label: "Often", value: 4 },
  { key: "consistently", label: "Consistently", value: 5 },
];

async function main() {
  console.log('Seeding initial configuration data...');

  // Questions
  await prisma.question.deleteMany({});
  for (let i = 0; i < defaultQuestions.length; i++) {
    await prisma.question.create({
      data: {
        domain: defaultQuestions[i].domain,
        text: defaultQuestions[i].text,
        order: i,
      },
    });
  }

  // Pressure Options
  await prisma.pressureOption.deleteMany({});
  for (let i = 0; i < defaultPressureOptions.length; i++) {
    await prisma.pressureOption.create({
      data: {
        key: defaultPressureOptions[i].key,
        title: defaultPressureOptions[i].title,
        hint: defaultPressureOptions[i].hint,
        order: i,
      },
    });
  }

  // System Config (Revenue, Stages, Scale Options, Unmasked Questionnaire)
  await prisma.systemConfig.deleteMany({});
  await prisma.systemConfig.create({
    data: { key: 'revenueBands', value: JSON.stringify(revenueBands) },
  });
  await prisma.systemConfig.create({
    data: { key: 'stages', value: JSON.stringify(stages) },
  });
  await prisma.systemConfig.create({
    data: { key: 'scaleOptions', value: JSON.stringify(scaleOptions) },
  });
  await prisma.systemConfig.create({
    data: {
      key: 'unmasked_questionnaire',
      value: JSON.stringify({
        step2: {
          step: 2,
          title: 'Your Result',
          questions: [
            { id: 'businessResult', text: 'What is the one business result, consequential decision or strategic challenge you want to address?', required: true },
            { id: 'attentionNow', text: 'Why does this require attention now?', required: true },
            { id: 'outcome90Days', text: 'What would a successful outcome make possible during the next 90 days?', required: true },
            { id: 'attemptedAlready', text: 'What have you already attempted, and what happened?(optional)', required: false }
          ]
        },
        step3: {
          step: 3,
          title: 'Your Readiness',
          notice: 'UNMASKED PRIVATE engagements start at AED 10,000 excluding VAT.',
          questions: [
            { id: 'decisionInfluence', text: 'Where may your own decisions, standards or behaviour be influencing the current result?', required: true },
            { id: 'challengeView', text: 'Describe a recent situation in which someone challenged your view and you changed your decision or approach.\nWhat did you initially believe, what changed your view and what did you do differently?', required: true },
            { id: 'authorityToAct', text: 'Do you have the authority and practical ability to act on the decisions that may emerge?', options: ['Yes', 'Partly', 'No'], required: true },
            { id: 'investmentReadiness', text: 'If there is a genuine fit, what level of investment are you currently prepared to make in accelerating this result?', options: [
              { label: 'Up to AED 5,000', value: 'UP_TO_5K' },
              { label: 'AED 5,001–9,999', value: 'FROM_5K_TO_10K' },
              { label: 'AED 10,000–14,999', value: 'FROM_10K_TO_15K' },
              { label: 'AED 15,000–19,999', value: 'FROM_15K_TO_20K' },
              { label: 'AED 20,000 or more', value: 'OVER_20K' },
            ], required: true },
            { id: 'availableForCall', text: 'Are you available for a confidential 30-minute conversation if Lionel determines there is a genuine fit?', options: ['Yes', 'No'], required: true }
          ]
        }
      })
    }
  });

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

declare const process: any;

const prisma = new PrismaClient();

const defaultQuestions = [
  { domain: "Founder Involvement", text: "How often does day-to-day progress depend on your direct involvement?" },
  { domain: "Decision Load", text: "How often can the business maintain momentum when you step back?" },
  { domain: "Execution Cadence", text: "How often do important decisions wait for your approval before work can continue?" },
  { domain: "Leadership Alignment", text: "How often are decisions resolved at the appropriate level without being escalated to you?" },
  { domain: "Operational Resilience", text: "How consistently are priorities translated into completed actions?" },
  { domain: "Decision Load", text: "How often do commitments or deadlines slip without your intervention?" },
  { domain: "Execution Cadence", text: "How consistently do leaders make and own decisions within clear boundaries?" },
  { domain: "Leadership Alignment", text: "How often do leaders wait for your direction before moving forward?" },
  { domain: "Operational Resilience", text: "How often can the current operating rhythm absorb additional pressure without losing focus or pace?" },
  { domain: "Founder Pressure", text: "How often does accumulated operational pressure reduce the quality or speed of decision-making?" },
];

const defaultPressureOptions = [
  { key: "decisions", title: "Too many decisions still require my involvement", hint: "Progress slows while people wait." },
  { key: "execution", title: "Execution is inconsistent", hint: "Commitments and deadlines are not reliably met." },
  { key: "leadership", title: "Leadership ownership is unclear", hint: "Responsibilities exist, but accountability is inconsistent." },
  { key: "growth", title: "Growth is increasing pressure on people and systems.", hint: "Complexity is rising faster than operating capacity." },
  { key: "unsure", title: "I’m not sure yet", hint: "The questions will help clarify where the pressure may be coming from." },
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

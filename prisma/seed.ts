import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

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

  // System Config (Revenue, Stages, Scale Options)
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

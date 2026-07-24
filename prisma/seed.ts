import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const defaultQuestions = [
  { domain: "Founder Pressure", text: "The business still requires my direct involvement to maintain momentum." },
  { domain: "Decision Load", text: "Too many operational decisions still escalate to me before the team can move forward." },
  { domain: "Execution Cadence", text: "Execution slows down when I am not actively involved." },
  { domain: "Leadership Alignment", text: "The leadership team needs my constant direction to stay aligned." },
  { domain: "Operational Resilience", text: "My current operating rhythm is difficult to sustain at the next stage of growth." },
  { domain: "Decision Load", text: "Key decisions often wait for my approval before progress continues." },
  { domain: "Execution Cadence", text: "The team's execution rhythm becomes inconsistent when I step back." },
  { domain: "Leadership Alignment", text: "Operational pressure increases when multiple teams depend on my direction at the same time." },
  { domain: "Operational Resilience", text: "Decision quality declines when operational pressure accumulates over time." },
  { domain: "Founder Pressure", text: "Sustaining current momentum requires more of my personal capacity than the business should demand." },
];

const defaultPressureOptions = [
  { key: "decisions", title: "Decisions keep returning to me", hint: "Founder approval loop" },
  { key: "execution", title: "Execution is inconsistent", hint: "Cadence or follow-through issue" },
  { key: "leadership", title: "Leadership ownership is unclear", hint: "Role and decision boundaries" },
  { key: "growth", title: "Growth is creating operational pressure", hint: "Scale is stressing the system" },
  { key: "unsure", title: "I'm not sure yet", hint: "Start broadly. The scan will narrow from your answers." },
];

const revenueBands = ["Under €1M", "€1M–€5M", "€5M–€15M", "€15M–€50M", "€50M+"];
const stages = ["Early-stage", "Growth-stage", "Scale-stage", "Mature"];
const scaleOptions = [
  { key: "sd", label: "Strongly Disagree", value: 1 },
  { key: "d", label: "Disagree", value: 2 },
  { key: "a", label: "Agree", value: 3 },
  { key: "sa", label: "Strongly Agree", value: 4 },
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

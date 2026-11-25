import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const articlesDir = path.resolve(__dirname, '../articles');

function countWords(str: string): number {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// 1. Process 01-09-2026.txt
function process01() {
  const raw = fs.readFileSync(path.join(articlesDir, '01-09-2026.txt'), 'utf8');
  const title = 'What Is Founder Dependency and Why It Is Not a Delegation Problem';
  const slug = 'what-is-founder-dependency';
  const pillar = 'The RESET Method';

  const body = raw
    .replace(/^What is Founder Dependency and why it is not a Delegation Problem\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^What Founder Dependency is$/m, '## What Founder Dependency Is')
    .replace(/^Founder Dependency versus Micromanagement$/m, '## Founder Dependency versus Micromanagement')
    .replace(/^How to Know if You are the Bottleneck in your own Business$/m, '## How to Know if You Are the Bottleneck in Your Own Business')
    .replace(/^What causes Founder Dependency$/m, '## What Causes Founder Dependency')
    .replace(/^Why it builds quietly as the company grows$/m, '### Why It Builds Quietly as the Company Grows')
    .replace(/^Why you built the company but now feel trapped inside it$/m, '### Why You Built the Company but Now Feel Trapped Inside It')
    .replace(/^Why delegation never fixed it$/m, '### Why Delegation Never Fixed It')
    .replace(/^The difference between delegation and removing founder dependency$/m, '### The Difference Between Delegation and Removing Founder Dependency')
    .replace(/^How to fix Founder Dependency: The Structural Approach$/m, '## How to Fix Founder Dependency: The Structural Approach')
    .replace(/^Step 1: Map Where Decisions Actually Route$/m, '### Step 1: Map Where Decisions Actually Route')
    .replace(/^Step 2: Rebuild the Structure, Not the Effort$/m, '### Step 2: Rebuild the Structure, Not the Effort')
    .replace(/^Why this is the work the RESET Blueprint does$/m, '### Why This Is the Work the RESET Blueprint Does')
    .replace(/^What Changes When Founder Dependency Is Removed$/m, '## What Changes When Founder Dependency Is Removed')
    .replace(/^FAQ$/m, '## Frequently Asked Questions')
    .replace(/^1\. What does it mean when a business cannot run without the founder\?$/m, '### 1. What does it mean when a business cannot run without the founder?')
    .replace(/^2\. How do you know if you are the bottleneck\?$/m, '### 2. How do you know if you are the bottleneck?')
    .replace(/^3\. Is founder dependency the same as micromanagement\?$/m, '### 3. Is founder dependency the same as micromanagement?')
    .replace(/^4\. What is the difference between delegation and removing founder dependency\?$/m, '### 4. What is the difference between delegation and removing founder dependency?')
    .replace(/^5\. What causes founder dependency\?$/m, '### 5. What causes founder dependency?')
    .replace(/^Find out if you are the Bottleneck: Take the Founder Pressure Scan$/m, '## Find Out if You Are the Bottleneck: Take the Founder Pressure Scan');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'Founder dependency is a structural condition where business decisions route through the founder by default. It is not solved by delegation or hiring, but by restructuring how authority, information, and accountability flow.';

  const meta_title = 'What Is Founder Dependency? | Leaders Performance';
  const meta_description =
    'Discover why founder dependency is a structural bottleneck rather than a delegation issue, and how to permanently remove it through the RESET Blueprint.';
  const keywords = [
    'founder dependency',
    'delegation',
    'founder bottleneck',
    'the reset method',
    'decision flow',
    'leadership structure',
    'scaling operations',
    'executive accountability',
  ];

  return {
    file: '01-09-2026.txt',
    db_id: '5d1edea2-c93e-48be-a6c5-649522671e99',
    old_slug: 'the-reset-blueprint-restoring-strategic-velocity',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

// 2. Process 08-09-2026.txt
function process08() {
  const raw = fs.readFileSync(path.join(articlesDir, '08-09-2026.txt'), 'utf8');
  const title = 'Founder Burnout Is Not a Lifestyle Problem, It Is a Structural Warning Signal';
  const slug = 'founder-burnout-structural-warning-signal';
  const pillar = 'Mental Performance';

  const body = raw
    .replace(/^Founder Burnout is not a Lifestyle Problem, it is a Structural Warning Signal\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^What Founder Burnout Is$/m, '## What Founder Burnout Is')
    .replace(/^Why "I Cannot Switch Off Anymore" Is a Structural Signal, Not a Weakness$/m, '## Why "I Cannot Switch Off Anymore" Is a Structural Signal, Not a Weakness')
    .replace(/^How Founder Burnout Is Different From Regular Burnout$/m, '## How Founder Burnout Is Different From Regular Burnout')
    .replace(/^Founder Burnout Versus Executive Burnout$/m, '## Founder Burnout Versus Executive Burnout')
    .replace(/^What Causes Founder Burnout$/m, '## What Causes Founder Burnout')
    .replace(/^Constant Firefighting and the Pressure Nobody Sees$/m, '### Constant Firefighting and the Pressure Nobody Sees')
    .replace(/^Why the Company Carrying Everything Through You Drains You$/m, '### Why the Company Carrying Everything Through You Drains You')
    .replace(/^Why Rest Alone Does Not Fix Founder Burnout$/m, '### Why Rest Alone Does Not Fix Founder Burnout')
    .replace(/^How to Recover From Founder Burnout Without Stepping Away From the Company$/m, '## How to Recover From Founder Burnout Without Stepping Away From the Company')
    .replace(/^Fix the Structure That Created the Pressure$/m, '### Fix the Structure That Created the Pressure')
    .replace(/^Is Founder Burnout a Mental Health Issue\?$/m, '## Is Founder Burnout a Mental Health Issue?')
    .replace(/^FAQ$/m, '## Frequently Asked Questions')
    .replace(/^1\. What causes founder burnout\?$/m, '### 1. What causes founder burnout?')
    .replace(/^2\. How is founder burnout different from regular burnout\?$/m, '### 2. How is founder burnout different from regular burnout?')
    .replace(/^3\. How is founder burnout different from executive burnout\?$/m, '### 3. How is founder burnout different from executive burnout?')
    .replace(/^4\. Can you recover from founder burnout without stepping away\?$/m, '### 4. Can you recover from founder burnout without stepping away?')
    .replace(/^5\. Is founder burnout a mental health issue\?$/m, '### 5. Is founder burnout a mental health issue?')
    .replace(/^See What Is Driving the Pressure: Take the Founder Pressure Scan$/m, '## See What Is Driving the Pressure: Take the Founder Pressure Scan');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'Founder burnout is not tiredness from working too hard, but a structural signal that business decisions route entirely through one person. Real recovery requires fixing operational design rather than temporary rest.';

  const meta_title = 'Founder Burnout: A Structural Warning Signal';
  const meta_description =
    'Founder burnout is not a lifestyle failure or fatigue. Learn why chronic founder depletion is a structural operational signal and how to recover sustainably.';
  const keywords = [
    'founder burnout',
    'mental performance',
    'structural burnout',
    'executive burnout',
    'founder recovery',
    'decision fatigue',
    'leadership stamina',
    'founder pressure scan',
  ];

  return {
    file: '08-09-2026.txt',
    db_id: '28e77779-fc58-40ec-b389-5fcf8488844c',
    old_slug: 'what-the-next-level-asks-of-the-founder',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

// 3. Process 11-08-2026.txt
function process11() {
  const raw = fs.readFileSync(path.join(articlesDir, '11-08-2026.txt'), 'utf8');
  const title = 'Growth Without Control';
  const slug = 'growth-without-control';
  const pillar = 'Growth Strategy';

  const body = raw
    .replace(/^Growth Without Control\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^The Founder Feeling$/m, '## The Founder Feeling')
    .replace(/^The Real Problem$/m, '## The Real Problem');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'Growth without control creates a dangerous illusion of success while weakening your grip on decisions. Scaling clean requires aligning operational structure, visibility, and decision flow before complexity catches up.';

  const meta_title = 'Growth Without Control | Leaders Performance';
  const meta_description =
    'Growth without control creates fragility and hidden risk. Understand why scaling requires structured decision flow and operational visibility.';
  const keywords = [
    'growth without control',
    'growth strategy',
    'scaling clean',
    'operational visibility',
    'decision flow',
    'risk exposure',
    'founder leadership',
  ];

  return {
    file: '11-08-2026.txt',
    db_id: '8f752ec8-efa6-498f-b3a9-aabe63cebb41',
    old_slug: 'decision-architecture-under-pressure',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

// 4. Process 15-09-2026.txt
function process15() {
  const raw = fs.readFileSync(path.join(articlesDir, '15-09-2026.txt'), 'utf8');
  const title = 'The Founder Bottleneck: What It Is, What Causes It, and What Actually Fixes It';
  const slug = 'the-founder-bottleneck-causes-and-fixes';
  const pillar = 'Founder Operations';

  const body = raw
    .replace(/^The Founder Bottleneck: What It Is, What Causes It, and What Actually Fixes It\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^What a Founder Bottleneck Is$/m, '## What a Founder Bottleneck Is')
    .replace(/^Leadership Bottleneck Definition$/m, '### Leadership Bottleneck Definition')
    .replace(/^How to Know If You Are the Bottleneck in Your Own Company$/m, '## How to Know If You Are the Bottleneck in Your Own Company')
    .replace(/^The Signals: My Team Keeps Bringing Problems Back to Me$/m, '### The Signals: My Team Keeps Bringing Problems Back to Me')
    .replace(/^Why I Do not Trust my People Enough to let go$/m, '### Why I Do Not Trust My People Enough to Let Go')
    .replace(/^What Causes a Founder Bottleneck$/m, '## What Causes a Founder Bottleneck')
    .replace(/^How It Forms as the Company Scales$/m, '### How It Forms as the Company Scales')
    .replace(/^Does Delegation Fix a Founder Bottleneck\?$/m, '### Does Delegation Fix a Founder Bottleneck?')
    .replace(/^How to Fix a Founder Bottleneck: A Structural Method$/m, '## How to Fix a Founder Bottleneck: A Structural Method')
    .replace(/^Step 1: Map Where the Decisions Pile Up$/m, '### Step 1: Map Where the Decisions Pile Up')
    .replace(/^Step 2: Identify Bottlenecks$/m, '### Step 2: Identify Bottlenecks')
    .replace(/^Step 3: Redistribute Ownership$/m, '### Step 3: Redistribute Ownership')
    .replace(/^Step 4: Build Operational Accountability$/m, '### Step 4: Build Operational Accountability')
    .replace(/^How Long Does It Take to Remove a Founder Bottleneck$/m, '## How Long Does It Take to Remove a Founder Bottleneck')
    .replace(/^FAQ$/m, '## Frequently Asked Questions')
    .replace(/^What Is a Founder Bottleneck\?$/m, '### What Is a Founder Bottleneck?')
    .replace(/^How Do You Know If You Are the Bottleneck in Your Own Company\?$/m, '### How Do You Know If You Are the Bottleneck in Your Own Company?')
    .replace(/^Does Delegation Fix a Founder Bottleneck\?$/m, '### Does Delegation Fix a Founder Bottleneck?')
    .replace(/^How Long Does It Take to Remove a Founder Bottleneck\?$/m, '### How Long Does It Take to Remove a Founder Bottleneck?')
    .replace(/^What Causes a Founder Bottleneck\?$/m, '### What Causes a Founder Bottleneck?')
    .replace(/^Can a Founder Bottleneck Exist Even When the Company Is Profitable\?$/m, '### Can a Founder Bottleneck Exist Even When the Company Is Profitable?')
    .replace(/^Find Out If You Are the Bottleneck: Take the Founder Pressure Scan$/m, '## Find Out If You Are the Bottleneck: Take the Founder Pressure Scan');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'A founder bottleneck occurs when personal capacity limits how fast a company decides and executes. It is an operational wiring issue where every decision routes through one desk, capping organizational growth.';

  const meta_title = 'The Founder Bottleneck: Causes & Fixes';
  const meta_description =
    'Understand what causes a founder bottleneck in companies of 10 to 50 people, why delegation fails, and how to fix it with the RESET Blueprint.';
  const keywords = [
    'founder bottleneck',
    'founder operations',
    'delegation failure',
    'reset blueprint',
    'decision rights',
    'operational accountability',
    'scaling bottlenecks',
    'leadership capacity',
  ];

  return {
    file: '15-09-2026.txt',
    db_id: '785577a5-1ce0-47ac-982b-5f07b79e528c',
    old_slug: 'the-cost-of-heroic-leadership',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

// 5. Process 18-08-2026.txt
function process18() {
  const raw = fs.readFileSync(path.join(articlesDir, '18-08-2026.txt'), 'utf8');
  const title = 'Founder Mental Load';
  const slug = 'founder-mental-load';
  const pillar = 'Mental Performance';

  const body = raw
    .replace(/^Founder Mental Load\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^Why This Is Dangerous$/m, '## Why This Is Dangerous')
    .replace(/^Reality Check$/m, '## Reality Check')
    .replace(/^Final Thought$/m, '## Final Thought');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'The heaviest burden for a founder is the constant thinking that never turns off. Carrying unresolved decisions and risks 24/7 signals a structural dependency that drains clarity and caps executive capacity.';

  const meta_title = 'Founder Mental Load | Leaders Performance';
  const meta_description =
    'The heaviest pressure on a founder is constant mental load. Discover why 24/7 thinking is a structural warning signal and how to restore clarity.';
  const keywords = [
    'founder mental load',
    'mental performance',
    'cognitive overload',
    'founder pressure',
    'decision fatigue',
    'executive clarity',
    'structural dependency',
  ];

  return {
    file: '18-08-2026.txt',
    db_id: '56b30ccc-3f4c-47d5-880f-e16f7a456a23',
    old_slug: 'ambition-creates-pressure',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

// 6. Process 25-08-2026.txt
function process25() {
  const raw = fs.readFileSync(path.join(articlesDir, '25-08-2026.txt'), 'utf8');
  const title = 'Hidden Conflicts';
  const slug = 'hidden-conflicts';
  const pillar = 'Leadership';

  const body = raw
    .replace(/^Hidden Conflicts\r?\n+/, '')
    .replace(/[•●]/g, '-')
    .replace(/^What Happens Next$/m, '## What Happens Next')
    .replace(/^Reality Check$/m, '## Reality Check');

  const content = `# ${title}\n\n${body.trim()}`;
  const totalWords = countWords(content);
  const reading_time = Math.ceil(totalWords / 200);

  const excerpt =
    'The most dangerous conflicts never explode—they spread silently through passive resistance and slow decisions. Left unaddressed to avoid friction, hidden team tensions erode trust, leadership alignment, and execution speed.';

  const meta_title = 'Hidden Conflicts | Leaders Performance';
  const meta_description =
    'Unspoken friction and avoided conversations in leadership teams destroy execution. Learn why surfacing hidden conflict fast is vital for performance.';
  const keywords = [
    'hidden conflicts',
    'leadership',
    'team friction',
    'executive alignment',
    'decision speed',
    'leadership strength',
    'organisational trust',
  ];

  return {
    file: '25-08-2026.txt',
    db_id: 'e74392ed-2633-4369-ab3e-66279cfaf960',
    old_slug: 'from-founder-performance-to-organisational-performance',
    article: {
      title,
      slug,
      excerpt,
      pillar,
      content,
      meta_title,
      meta_description,
      author: 'Lionel Eersteling',
      reading_time,
      keywords,
      published: true,
    },
  };
}

async function main() {
  console.log('--- Starting CMS Article Replacement in Database ---');

  // Verify initial count
  const initialCountRows = await prisma.$queryRawUnsafe<any[]>('SELECT count(*) as count FROM public.articles;');
  const initialCount = parseInt(initialCountRows[0].count, 10);
  console.log(`Initial articles in database: ${initialCount}`);

  const items = [process01(), process08(), process11(), process15(), process18(), process25()];
  const results: any[] = [];

  for (const item of items) {
    const a = item.article;
    console.log(`Updating DB ID: ${item.db_id} (${item.old_slug} -> ${a.slug})...`);

    const updateRows = await prisma.$queryRawUnsafe<any[]>(
      `
      UPDATE public.articles
      SET
        title = $1,
        slug = $2,
        excerpt = $3,
        pillar = $4,
        content = $5,
        meta_title = $6,
        meta_description = $7,
        author = $8,
        reading_time = $9,
        keywords = $10::text[],
        published = $11,
        updated_at = NOW()
      WHERE id = $12::uuid
      RETURNING id, slug, title, updated_at;
    `,
      a.title,
      a.slug,
      a.excerpt,
      a.pillar,
      a.content,
      a.meta_title,
      a.meta_description,
      a.author,
      a.reading_time,
      a.keywords,
      a.published,
      item.db_id
    );

    if (updateRows.length === 0) {
      throw new Error(`Failed to update article with ID ${item.db_id} - record not found!`);
    }

    results.push({
      file: item.file,
      id: updateRows[0].id,
      old_slug: item.old_slug,
      new_slug: updateRows[0].slug,
      title: updateRows[0].title,
      updated_at: updateRows[0].updated_at,
    });
  }

  // Verify post-migration count
  const finalCountRows = await prisma.$queryRawUnsafe<any[]>('SELECT count(*) as count FROM public.articles;');
  const finalCount = parseInt(finalCountRows[0].count, 10);
  console.log(`Final articles in database: ${finalCount}`);
  console.log(`Duplicates created: ${finalCount - initialCount}`);

  console.log('\n--- SUCCESS REPORT ---');
  console.log(JSON.stringify(results, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  prisma.$disconnect();
  process.exit(1);
});

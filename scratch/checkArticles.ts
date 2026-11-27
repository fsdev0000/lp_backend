import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const slugs = [
    'why-senior-hires-fail-founder-led-companies-structural-issues',
    'founder-burnout-not-lifestyle-problem-structural-warning-signal',
    'founder-bottleneck-what-it-is-causes-fixes',
    'what-is-founder-dependency-why-not-delegation-problem',
    'i-built-the-company-but-now-i-am-trapped-inside-it',
    'founder-mode-vs-manager-mode',
  ];

  for (const slug of slugs) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT slug, title, content, translations FROM public.articles WHERE LOWER(slug) = LOWER($1);`,
      slug
    );
    if (!rows.length) {
      console.log(`Article not found: ${slug}`);
      continue;
    }
    const a = rows[0];
    const enHeadings = (a.content.match(/^#{1,6}\s+.+$/gm) || []).length;
    const nl = a.translations?.nl;
    const nlHeadings = nl?.content ? (nl.content.match(/^#{1,6}\s+.+$/gm) || []).length : 0;
    const nlHasToken = nl?.content ? /LP[\s_]*TOKEN/i.test(nl.content) : false;
    const nlExcerptHasToken = nl?.excerpt ? /LP[\s_]*TOKEN/i.test(nl.excerpt) : false;
    const nlTitleHasToken = nl?.title ? /LP[\s_]*TOKEN/i.test(nl.title) : false;

    console.log(`=== ${slug} ===`);
    console.log(`English headings: ${enHeadings}, Dutch headings: ${nlHeadings}`);
    console.log(`Dutch has LP TOKEN: content=${nlHasToken}, excerpt=${nlExcerptHasToken}, title=${nlTitleHasToken}`);
    if (nl?.title) console.log(`Dutch title: "${nl.title}"`);
    console.log('');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixArticleBullets() {
  const slug = 'why-do-i-still-have-to-chase-everything';
  console.log(`[Articles] Checking article with slug: ${slug}...`);

  try {
    const article = await prisma.article.findUnique({
      where: { slug },
    });

    if (!article) {
      console.warn(`[Articles] Article with slug "${slug}" not found in database.`);
      return;
    }

    const originalContent = article.content;
    // Replace Unicode bullet characters (•, ●, etc.) at the start of lines with standard markdown unordered list item (- )
    const updatedContent = originalContent
      .replace(/^[ \t]*[•●][ \t]*/gm, '- ')
      .replace(/\n• /g, '\n- ');

    if (originalContent === updatedContent) {
      console.log(`[Articles] No typed bullet characters found or already updated.`);
      return;
    }

    await prisma.article.update({
      where: { slug },
      data: {
        content: updatedContent,
        updatedAt: new Date(),
      },
    });

    console.log(`[Articles] Successfully updated "${article.title}" content with markdown bullet lists.`);
  } catch (err: any) {
    console.error(`[Articles] Error fixing article bullets:`, err?.message || err);
  } finally {
    await prisma.$disconnect();
  }
}

fixArticleBullets();

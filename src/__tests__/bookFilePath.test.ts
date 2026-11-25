import path from 'path';
import { getBookFilePath } from '../api/routes/checkout';

describe('getBookFilePath Strict .env Security & Dynamic Resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BOOK_FILE_PATH;
    delete process.env.BOOK_FILE_PATH_EN;
    delete process.env.BOOK_FILE_PATH_NL;
    delete process.env.BOOK_FILE_NAME_EN;
    delete process.env.BOOK_FILE_NAME_NL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves English dummy book and uses .env configured filename for download', () => {
    process.env.BOOK_FILE_PATH_EN = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf';
    const result = getBookFilePath('en');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
  });

  it('resolves Dutch dummy book and uses .env configured filename for download', () => {
    process.env.BOOK_FILE_PATH_NL = './private/RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf';
    const result = getBookFilePath('nl');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf');
  });

  it('supports explicit custom download filename via BOOK_FILE_NAME_EN', () => {
    process.env.BOOK_FILE_PATH_EN = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf';
    process.env.BOOK_FILE_NAME_EN = 'RESET BY DISCIPLINE - ENGLISH.pdf';
    const result = getBookFilePath('en');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - ENGLISH.pdf');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
  });

  it('resolves dummy book even if BOOK_FILE_PATH_EN is just the bare filename without ./private/', () => {
    process.env.BOOK_FILE_PATH_EN = 'RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf';
    const result = getBookFilePath('en');
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
  });

  it('resolves dummy book even if BOOK_FILE_PATH_NL is wrapped in quotes in .env', () => {
    process.env.BOOK_FILE_PATH_NL = '"./private/RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf"';
    const result = getBookFilePath('nl');
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf');
  });

  it('blocks download and returns null if .env path is missing (NO hardcoded fallback loopholes)', () => {
    delete process.env.BOOK_FILE_PATH_EN;
    delete process.env.BOOK_FILE_PATH;
    const result = getBookFilePath('en');
    expect(result).toBeNull();
  });

  it('blocks download and returns null if configured file does not end in .pdf (anti-traversal guard)', () => {
    process.env.BOOK_FILE_PATH_EN = './private/service_account.json';
    const result = getBookFilePath('en');
    expect(result).toBeNull();
  });

  it('blocks download and returns null if configured file does not exist on disk', () => {
    process.env.BOOK_FILE_PATH_EN = './private/non_existent_file.pdf';
    const result = getBookFilePath('en');
    expect(result).toBeNull();
  });
});

import path from 'path';
import { getBookFilePath } from '../api/routes/checkout';

describe('getBookFilePath Dynamic .env Resolution', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves English dummy book when BOOK_FILE_PATH_EN is set to ./private/ filename', () => {
    process.env.BOOK_FILE_PATH_EN = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf';
    const result = getBookFilePath('en');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - ENGLISH.pdf');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
  });

  it('resolves Dutch dummy book when BOOK_FILE_PATH_NL is set to ./private/ filename', () => {
    process.env.BOOK_FILE_PATH_NL = './private/RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf';
    const result = getBookFilePath('nl');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - DUTCH.pdf');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - DUTCH (STAGING DUMMY).pdf');
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

  it('falls back to BOOK_FILE_PATH when BOOK_FILE_PATH_EN is not provided', () => {
    delete process.env.BOOK_FILE_PATH_EN;
    process.env.BOOK_FILE_PATH = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf';
    const result = getBookFilePath('en');
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).pdf');
  });
});

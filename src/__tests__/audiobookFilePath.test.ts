import path from 'path';
import { getAudiobookFilePath } from '../services/audiobookService';

describe('getAudiobookFilePath Strict .env Security & Dynamic Resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AUDIOBOOK_FILE_PATH;
    delete process.env.AUDIOBOOK_FILE_PATH_EN;
    delete process.env.AUDIOBOOK_FILE_NAME_EN;
    delete process.env.AUDIOBOOK_FILE_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves English dummy audiobook and uses .env configured filename for download', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3';
    const result = getAudiobookFilePath();
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3');
  });

  it('supports explicit custom download filename via AUDIOBOOK_FILE_NAME_EN', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = './private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3';
    process.env.AUDIOBOOK_FILE_NAME_EN = 'RESET BY DISCIPLINE - ENGLISH.mp3';
    const result = getAudiobookFilePath();
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('RESET BY DISCIPLINE - ENGLISH.mp3');
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3');
  });

  it('resolves dummy audiobook even if AUDIOBOOK_FILE_PATH_EN is just the bare filename without ./private/', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = 'RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3';
    const result = getAudiobookFilePath();
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3');
  });

  it('resolves dummy audiobook even if AUDIOBOOK_FILE_PATH_EN is wrapped in quotes in .env', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = '"./private/RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3"';
    const result = getAudiobookFilePath();
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain('RESET BY DISCIPLINE - ENGLISH (STAGING DUMMY).mp3');
  });

  it('blocks audio access and returns null if .env path is missing (NO hardcoded fallback loopholes)', () => {
    delete process.env.AUDIOBOOK_FILE_PATH_EN;
    delete process.env.AUDIOBOOK_FILE_PATH;
    const result = getAudiobookFilePath();
    expect(result).toBeNull();
  });

  it('blocks audio access and returns null if configured file is not an audio file (anti-traversal guard)', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = './private/service_account.json';
    const result = getAudiobookFilePath();
    expect(result).toBeNull();
  });

  it('blocks audio access and returns null if configured file does not exist on disk', () => {
    process.env.AUDIOBOOK_FILE_PATH_EN = './private/non_existent_audio.mp3';
    const result = getAudiobookFilePath();
    expect(result).toBeNull();
  });
});

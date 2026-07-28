import { ElevenLabsClient } from 'elevenlabs';
import { getSecret } from './src/services/secrets.js';
import fs from 'fs';

async function testTTS() {
  try {
    const key = await getSecret('ELEVENLABS_API_KEY');
    console.log('API Key starts with:', key ? key.substring(0, 5) + '...' : 'MISSING');
    if (!key) {
      console.log('No API key found!');
      return;
    }
    
    const voiceId = await getSecret('ELEVENLABS_VOICE_ID') || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    console.log('Using voice ID:', voiceId);

    const client = new ElevenLabsClient({ apiKey: key });
    
    console.log('Calling textToSpeech.convert...');
    const audioStream = await client.textToSpeech.convert(voiceId, {
      text: "Hello World",
      model_id: "eleven_turbo_v2",
      output_format: "mp3_44100_128"
    });
    
    console.log('Success! Stream object:', typeof audioStream);
    process.exit(0);
  } catch (err) {
    console.error('ERROR during TTS:');
    console.error(err);
    process.exit(1);
  }
}

testTTS();

import { getSecret } from './src/services/secrets';
import { ElevenLabsClient } from 'elevenlabs';
import fs from 'fs';

async function main() {
    try {
        console.log('Fetching secrets...');
        const key = await getSecret('ELEVENLABS_API_KEY');
        if (!key) {
            console.error('ELEVENLABS_API_KEY not found in Vault or env');
            process.exit(1);
        }
        console.log('API Key fetched:', key.substring(0, 4) + '...');
        
        const voiceId = await getSecret('ELEVENLABS_VOICE_ID') || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        console.log('Using Voice ID:', voiceId);

        const client = new ElevenLabsClient({ apiKey: key });

        console.log('Calling textToSpeech...');
        const audioStream = await client.textToSpeech.convert(voiceId, {
            text: "Hello from Daisy. This is a local system test.",
            model_id: "eleven_turbo_v2",
            output_format: "mp3_44100_128"
        });

        console.log('Writing to file...');
        const writeStream = fs.createWriteStream('test_audio.mp3');
        
        // Use for await loop like the real endpoint
        for await (const chunk of audioStream) {
            writeStream.write(chunk);
        }
        writeStream.end();

        console.log('Success! Saved to test_audio.mp3');
        process.exit(0);
    } catch (e: any) {
        console.error('FAILED!', e.message);
        if (e.response) {
            console.error('Response data:', e.response.data);
        }
        process.exit(1);
    }
}

main();

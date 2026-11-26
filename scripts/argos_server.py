import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
import argostranslate.translate

class TranslateHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Quiet logger
        pass

    def do_GET(self):
        if self.path == '/languages':
            languages = argostranslate.translate.get_installed_languages()
            res = [{'code': l.code, 'name': l.name} for l in languages]
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(res).encode('utf-8'))
        elif self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/translate':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(body)
                q = data.get('q', '')
                source = data.get('source', 'en')
                target = data.get('target', 'nl')
                
                if not q:
                    translated = ''
                else:
                    translated = argostranslate.translate.translate(q, source, target)

                response = json.dumps({'translatedText': translated}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(response)
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

def run(port=5000):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, TranslateHandler)
    print(f"Argos Translate HTTP Server listening on http://127.0.0.1:{port}")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    run(port)

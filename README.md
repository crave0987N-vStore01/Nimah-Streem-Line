Nimah Streem Line

No Railway variables are needed.

1. firebase-key.json is already included (rotate it later in Google Cloud Console and replace the file).
2. Realtime Database > Rules: keep the "streem" node closed to the public:
   "streem": { ".read": false, ".write": false }
3. Push this folder to a PRIVATE GitHub repo (firebase-key.json is a secret), then
   Railway > New Project > Deploy from GitHub.
4. Settings > Networking > Generate Domain, use that URL in median.co.

Everything else works by default (phone + password login, calls with a public TURN relay).
Optional variables later: ONESIGNAL_APP_ID, ONESIGNAL_API_KEY (push), TURN_URL, TURN_USER, TURN_PASS,
Twilio or Notify.lk keys (SMS codes), DATABASE_URL (PostgreSQL instead of Firebase).

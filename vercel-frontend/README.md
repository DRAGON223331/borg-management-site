# إدارة البرج — نشر مستقل على Vercel

هذا المجلد أصبح نسخة مستقلة كاملة، تشمل الواجهة وواجهات API. لم يعد يحتاج إلى خادم Backend خارجي أو رابط تجريبي.

## إعدادات Vercel

- **Root Directory:** `vercel-frontend` إذا اخترت هذا المجلد كجذر، أو `./` إذا اخترت جذر المستودع الأساسي.
- **Framework Preset:** Other
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

أضف متغيرات البيئة المطلوبة كما هو موضح في `../README.md`، خصوصًا متغيرات PostgreSQL وDiscord و`SESSION_SECRET` و`SITE_URL` و`DISCORD_REDIRECT_URI`. يجب أن يكون `SITE_URL` هو رابط الموقع المنشور نفسه، ويجب إضافة رابط `/auth/callback` إلى Discord Developer Portal.

بعد الحفظ، أعد النشر من Vercel. لن تعمل عمليات المهمات أو الشات ما لم تنشر مجلدًا يحتوي على `api/` بجانب `package.json` و`vercel.json`.

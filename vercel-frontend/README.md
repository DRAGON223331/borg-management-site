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

The project includes explicit API wrappers for nested task, chat, submission-review, staff-request-review, and staff-profile routes. Ensure this folder is deployed with its `api/` directory intact; deploying only `site-src/` or the generated `dist/` folder will cause API requests to return Vercel `NOT_FOUND` errors.


## إحصائيات الإدارة والطلبات الإدارية
تعرض الصفحة الرئيسية ملخصات المسؤولين، والضغط على اسم عضو من القائمة الجانبية يفتح ملفه الكامل. يستطيع عضو الاستاف إرسال طلب إجازة أو طلب إداري آخر (إذن/غياب، مشكلة تقنية، تعديل بيانات، شكوى/ملاحظة، أو طلب آخر). تصل طلبات الإجازة والطلبات الإدارية إلى روم المراجعة `1558102515885678734`، ويمكن لمسؤولي الإدارة قبولها أو رفضها من لوحة الموقع. الموافقة على طلب عادي لا تغيّر رتب Discord؛ الرتبتان المعرّفتان في إعدادات الموقع تُستخدمان لتحديد صلاحيات الإدارة فقط.

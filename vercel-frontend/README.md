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

The project includes explicit API wrappers for nested task, chat, and submission-review routes. Ensure this folder is deployed with its `api/` directory intact; deploying only `site-src/` or the generated `dist/` folder will cause API requests to return Vercel `NOT_FOUND` errors.


## طلبات الانضمام للإدارة
تُرسل الطلبات إلى روم المراجعة `1558102515885678734`. عند الموافقة، يضيف البوت `MANAGEMENT_MAIN_ROLE_ID` في `MAIN_GUILD_ID` و`MANAGEMENT_STAFF_ROLE_ID` في `STAFF_GUILD_ID`. امنح البوت صلاحية Manage Roles وارفع رتبته فوق الرتبتين المستهدفتين، وتأكد أن المتقدم عضو في السيرفرين.


## إحصائيات الإدارة وطلبات الترقية
تعرض الصفحة الرئيسية ملخصات المسؤولين، والضغط على اسم عضو من القائمة الجانبية يفتح ملفه الكامل. طلبات الانضمام للإدارة تُرسل إلى روم المراجعة `1558102515885678734` ويمكن قبولها أو رفضها من لوحة الموقع. الموافقة تضيف الرتبتين المحددتين أعلاه، بشرط صلاحيات البوت ووجود المتقدم في السيرفرين.

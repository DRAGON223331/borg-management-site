# إدارة البرج — موقع متابعة الاستاف والمهمات

موقع عربي باتجاه RTL لتسجيل الدخول بديسكورد، وعرض أعضاء سيرفر الاستاف حسب أعلى رتبة، وشات الاستاف وشات المسؤولين، وإدارة المهمات الإجباري/الاختياري، وتسليم الأدلة بالروابط أو الصور أو الفيديوهات.

## تنبيه أمني مهم

توكن البوت الذي أُرسل في المحادثة يجب اعتباره مكشوفًا. اعمل Reset له من Discord Developer Portal، وبعدها أضف التوكن الجديد إلى متغير `DISCORD_BOT_TOKEN` على الخادم فقط. لا تضعه في ملفات `public/` أو مجلد `vercel-frontend/` ولا ترفعه إلى GitHub.

## طريقة النشر المناسبة للمشروع

المشروع مقسوم إلى جزأين حتى يعمل بشكل صحيح:

- `vercel-frontend/` — واجهة الموقع الثابتة، تُنشر على Vercel.
- بقية المشروع (`server.js`) — خادم Express واتصال البوت وقاعدة SQLite ورفع الأدلة، يُشغّل على خدمة Node.js دائمة مثل Render.

لا ترفع المشروع كله كـ Node serverless function على Vercel وتعتبره جاهزًا؛ الخادم يحتاج عملية بوت مستمرة وتخزينًا دائمًا لقاعدة البيانات والملفات. نظام الملفات في Vercel Functions للقراءة فقط ما عدا مساحة مؤقتة، لذلك SQLite والملفات المحفوظة محليًا لا يصلح الاعتماد عليها كتخزين دائم هناك.

## 1) تجهيز Discord

في Discord Developer Portal:

1. خذ `Client Secret` من OAuth2.
2. فعّل `Server Members Intent` و`Message Content Intent` من تبويب Bot.
3. أضف Redirect URL المطابق تمامًا لمتغير `DISCORD_REDIRECT_URI` على الخادم. عند النشر، يكون بالشكل `https://YOUR-VERCEL-DOMAIN/auth/callback`.
4. أضف البوت إلى سيرفر الاستاف وأعطه صلاحيات رؤية وقراءة تاريخ رسائل روم المهمات وروم التسليم، وإرسال الرسائل وإرفاق الملفات.

المعرّفات الموجودة افتراضيًا:

- Client ID: `1559176035432402976`
- السيرفر الأساسي: `883871561474539630`
- سيرفر الاستاف: `1556647204255568063`
- روم المهمات: `1556647204960346215`
- روم التسليم: `1556651404154642504`
- المسؤولون: موجودون في `MANAGER_IDS` بملف `.env.example`.

## 2) نشر الخادم على Render

1. ارفع المشروع إلى GitHub كمستودع خاص، ولا ترفع ملف `.env` أو توكن البوت.
2. في Render اختر **New → Web Service** واربط المستودع.
3. استخدم جذر المستودع (Root Directory فارغ)، وBuild Command `npm install` وStart Command `npm start`.
4. أضف قرصًا دائمًا (Persistent Disk) بمسار mount هو `/var/data`.
5. أضف متغيرات البيئة التالية من لوحة Render:

   ```text
   NODE_ENV=production
   SITE_URL=https://YOUR-VERCEL-DOMAIN
   DISCORD_CLIENT_ID=1559176035432402976
   DISCORD_CLIENT_SECRET=ضع_قيمة_Client_Secret_هنا
   DISCORD_REDIRECT_URI=https://YOUR-VERCEL-DOMAIN/auth/callback
   DISCORD_BOT_TOKEN=ضع_التوكن_الجديد_هنا
   SESSION_SECRET=قيمة_عشوائية_طويلة_وفريدة_لا_تقل_عن_32_حرفًا
   DATA_DIR=/var/data
   UPLOAD_DIR=/var/data/uploads
   MAIN_GUILD_ID=883871561474539630
   STAFF_GUILD_ID=1556647204255568063
   TASKS_CHANNEL_ID=1556647204960346215
   TASK_SUBMISSIONS_CHANNEL_ID=1556651404154642504
   MANAGER_IDS=1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552
   DISCORD_ATTACHMENT_LIMIT_MB=8
   MAX_UPLOAD_MB=100
   ```

6. بعد نجاح النشر، انسخ عنوان خدمة الخادم، مثل `https://YOUR-BACKEND.onrender.com`. في أول إعداد، يمكن وضع عنوان Vercel مؤقتًا بالشكل `https://YOUR-PROJECT.vercel.app` في `SITE_URL` و`DISCORD_REDIRECT_URI`، ثم استبداله بالرابط الحقيقي بعد نشر الواجهة.

**مهم:** التخزين الدائم في Render يتطلب خطة تدعم Persistent Disk. من دون قرص دائم، قد تضيع قاعدة SQLite والملفات عند إعادة التشغيل أو النشر. ولأن البوت يحتاج اتصال Discord Gateway مستمرًا، استخدم خدمة لا تدخل في وضع السكون أثناء عمل البوت.

## 3) تجهيز واجهة Vercel

1. افتح `vercel-frontend/vercel.json`.
2. استبدل كل ظهور لـ `https://replace-with-your-backend.onrender.com` بعنوان خدمة Render الحقيقي، مع الإبقاء على المسارات `/api/`, `/auth/`, و`/uploads/`.
3. في Vercel أنشئ مشروعًا جديدًا من مستودع GitHub.
4. عيّن **Root Directory** إلى `vercel-frontend`.
5. إعدادات البناء:
   - Build Command: `npm run build`
   - Output Directory: `dist`
6. بعد ظهور رابط Vercel النهائي، ارجع إلى إعدادات Render واستبدل القيم المؤقتة بالرابط الحقيقي: `SITE_URL=https://YOUR-REAL-VERCEL-DOMAIN` و`DISCORD_REDIRECT_URI=https://YOUR-REAL-VERCEL-DOMAIN/auth/callback`. بعد ذلك أضف عنوان Redirect نفسه في Discord Developer Portal وأعد نشر الخادم.

ملفات واجهة Vercel تكون منفصلة عن الخادم، وطلبات `/api/*` و`/auth/*` و`/uploads/*` يتم تمريرها إلى خادم Render عن طريق rewrites. الشات يحدّث الرسائل بالاستعلام الدوري بدل الاعتماد على WebSocket عبر النطاقين.

## التشغيل محليًا

1. انسخ `.env.example` إلى `.env`.
2. اترك `DATA_DIR` و`UPLOAD_DIR` غير مضبوطين محليًا، أو علّق السطرين، ليستخدم المشروع المجلدين المحليين `data/` و`uploads/`.
3. أدخل `DISCORD_CLIENT_SECRET` وتوكن البوت الجديد وقيمة `SESSION_SECRET`.
4. اجعل `DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback` وأضف الرابط نفسه في Discord Developer Portal.
5. شغّل:

   ```bash
   npm install
   npm start
   ```

6. افتح `http://localhost:3000`.

## المهمات والتسليمات

- المسؤول يضيف أكثر من مهمة ويحدد كل واحدة إجباري أو اختياري.
- يمكن استيراد المهام من رسائل روم المهمات إذا كان كل سطر بتنسيق مثل:

  ```text
  • [إجباري] مراجعة طلبات الاستاف
  • [اختياري] تجهيز تقرير أسبوعي
  1. [إجباري] متابعة الشكاوى
  ```

- الاستاف يختار مهمة أو أكثر أنجزها ويضيف روابط أدلة أو يرفع صورة/فيديو.
- يسجل التسليم في SQLite ويُرسل ملخصه إلى روم التسليم. الملفات الأصغر من حد `DISCORD_ATTACHMENT_LIMIT_MB` يمكن إرفاقها برسالة Discord أيضًا، ويظل رابط الموقع مرفقًا لباقي الملفات.
- الملف الواحد له حد افتراضي قدره `100MB` في الخادم، وتأكد من اختبار رفع فيديو بعد النشر لأن حدود الرفع قد تختلف حسب مسار الاستضافة.

## فحص ملفات المشروع

قبل النشر محليًا يمكن تشغيل:

```bash
npm run check
cd vercel-frontend
npm run build
```

لا يمكن اعتبار اتصال Discord فعليًا مختبرًا حتى تضبط قيم الأسرار الحقيقية وتختبر تسجيل الدخول، ظهور أعضاء الاستاف، إنشاء مهمة، وتسليم دليل على الخدمة المنشورة.

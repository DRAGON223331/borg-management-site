# Vercel frontend — إدارة البرج

داخل إعدادات مشروع Vercel اختر `vercel-frontend` كـ **Root Directory**.

قبل النشر، افتح `vercel.json` واستبدل `https://replace-with-your-backend.onrender.com` بعنوان خادم الـAPI الفعلي. هذا المشروع ينشر الواجهة فقط؛ يجب نشر خادم `server.js` بشكل منفصل على خدمة Node.js دائمة، ثم ضبط `SITE_URL` و`DISCORD_REDIRECT_URI` في إعدادات الخادم على رابط Vercel.

راجع `../README.md` لخطوات النشر وإعدادات Discord كاملة.

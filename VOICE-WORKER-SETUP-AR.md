# إعداد بوت الفويس على Pella وربطه بالموقع

## 1) رفع البوت على Pella
ارفع المشروع، واجعل مجلد التشغيل `voice-worker` (Root Directory / Working Directory). الإعدادات:

- Runtime: Node.js 20 أو أحدث
- Install: `npm install`
- Start: `npm start`
- فعّل Persistent Volume / Disk واربطه بمجلد بيانات التطبيق، ثم ضع مساره الحقيقي في `DATA_DIR`.

## 2) متغيرات Pella
- `DISCORD_BOT_TOKEN`: توكن البوت الحالي.
- `VOICE_API_KEY`: سر عشوائي طويل (32 حرفًا على الأقل). أنشئ قيمة جديدة ولا تستخدم توكن Discord نفسه.
- `VOICE_GUILD_ID`: `1556647204255568063` لسيرفر الاستاف، أو غيّره إلى ID السيرفر المراد تتبعه.
- `DATA_DIR`: مسار الـ Persistent Volume الذي أنشأته في Pella.
- `PORT`: اترك Pella توفره تلقائيًا.

في Discord Developer Portal > Bot فعّل **Server Members Intent**. البوت يحتاج صلاحية View Channels في السيرفر. لا يحتاج Message Content أو Presence Intent.

## 3) متغيرات Vercel
في Project Settings > Environment Variables أضف:
- `VOICE_WORKER_URL`: رابط الخدمة العامة على Pella بدون `/` في النهاية، مثال `https://your-voice-worker.example`.
- `VOICE_WORKER_PUBLIC_URL` (اختياري على Pella): ضع فيه الدومين العام الذي تخصصه Pella للخدمة؛ سيطبعه البوت تلقائيًا في Console. لا يمكن للكود إنشاء دومين عام من دون أن توفره منصة الاستضافة.
- `VOICE_API_KEY`: نفس القيمة الموجودة على Pella حرفيًا.

أعد Deploy للموقع بعد إضافة المتغيرات. مسار الموقع الحالي `/api/voice-time` سيقرأ من البوت، ومسار `/api/voice-time/DISCORD_USER_ID` سيعرض بيانات العضو نفسه وفق صلاحيات الموقع.

## 4) اختبار التشغيل
- افتح `https://رابط-خدمة-Pella/health` ويجب أن يرجع `ok: true` و `ready: true`.
- لا تفتح `/voice-time` يدويًا من المتصفح؛ فهو محمي بمفتاح سري.
- بعد دخول عضو فويس، راجع لوحة الموقع. تظهر مدة اليوم وآخر 24 و42 و72 ساعة.

## تنبيهات
- التخزين JSON فقط، لا توجد حاجة إلى `DATABASE_URL` لهذا الـ Voice Worker.
- لا تضع `VOICE_API_KEY` في ملفات الواجهة أو GitHub؛ ضعه في Environment Variables فقط.
- إذا لم يكن لدى Pella تخزين دائم، ستُفقد سجلات JSON عند حذف/إعادة إنشاء مساحة التشغيل. تأكد من الـ Persistent Volume.
- عند Restart، لا يحسب البوت وقت التوقف. يغلق الجلسات عند آخر نبضة محفوظة ثم يعيد اكتشاف الموجودين حاليًا في الفويس.
- هذا مجلد بوت فويس مستقل. لا تشغّل عمليتين تستخدمان Discord Bot Token نفسه في الوقت نفسه. لو البوت الحالي يشغّل أوامر أخرى على نفس التوكن، أوقف نسخته الثانية أو ندمج كود التتبع داخل العملية الحالية بدل تشغيل Worker إضافي؛ وإلا قد تتعارض جلسات Discord Gateway.

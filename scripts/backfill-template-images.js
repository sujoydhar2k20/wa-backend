/**
 * Backfill hosted header images for template messages sent BEFORE the fix, so they render on
 * web and in the Android app.
 *
 * For every template with an IMAGE header:
 *   1. make sure a stable hosted copy exists (downloads the stored imageUrl once; if Meta's
 *      example URL has already expired this fails and the template is reported so an admin can
 *      re-upload a header image in Templates -> "Upload header image")
 *   2. set metadata.templateImageUrl on that template's existing messages.
 *
 * DRY RUN by default (changes nothing). Add --apply to write.
 *   node scripts/backfill-template-images.js
 *   node scripts/backfill-template-images.js --apply
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const Template = require('../src/models/Template');
const Message = require('../src/models/Message');
const whatsappService = require('../src/services/whatsapp.service');
const { connectDB } = require('../src/config/database');

const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (no changes)');
  const templates = await Template.find({ 'components.format': 'IMAGE' });
  let hostedNow = 0, alreadyHosted = 0, failed = [], messagesUpdated = 0;

  for (const t of templates) {
    const header = (t.components || []).find((c) => (c.type || '').toUpperCase() === 'HEADER' && (c.format || '').toUpperCase() === 'IMAGE');
    if (!header) continue;
    let url = header.hostedImageUrl;

    if (url) {
      alreadyHosted++;
    } else if (header.imageUrl) {
      try {
        const r = await axios.get(header.imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
        const mime = (r.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        if (APPLY) url = await whatsappService.hostTemplateHeaderImage(t, header, Buffer.from(r.data), mime);
        else url = '(would host)';
        if (url) hostedNow++;
      } catch (e) {
        failed.push(`${t.name} [${t.language}]: ${e.message}`);
        continue;
      }
    } else {
      failed.push(`${t.name} [${t.language}]: no image source stored`);
      continue;
    }

    const filter = {
      type: 'template',
      'metadata.templateName': t.name,
      'metadata.templateImageUrl': { $exists: false },
    };
    const count = await Message.countDocuments(filter);
    console.log(`${t.name} [${t.language}] -> ${count} message(s) ${APPLY ? 'updated' : 'would be updated'}`);
    if (APPLY && count && url && url !== '(would host)') {
      const res = await Message.updateMany(filter, { $set: { 'metadata.templateImageUrl': url } });
      messagesUpdated += res.modifiedCount || 0;
    }
  }

  console.log(`\nTemplates with image header: ${templates.length}`);
  console.log(`Already hosted: ${alreadyHosted}, hosted now: ${hostedNow}, messages updated: ${messagesUpdated}`);
  if (failed.length) {
    console.log(`\nNeed a manual header-image upload (source URL unusable):`);
    failed.forEach((f) => console.log('  - ' + f));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });

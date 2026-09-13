import { createHash } from 'node:crypto';
import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { DocumentRecord } from '../models/DocumentRecord.js';
import { enqueueProcessing } from '../services/taskGateway.js';

const router = Router();

const uploadSchema = z.object({
  fileName: z.string().min(1).max(180),
  content: z.string().min(1).max(100_000)
});

router.get('/', async (req, res, next) => {
  try {
    const items = await DocumentRecord.find({
      organisationId: req.demoUser.organisationId
    })
      .select('-sourceText')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = uploadSchema.parse(req.body);
    const uploadFingerprint = createHash('sha256')
      .update(`${req.demoUser.organisationId}:${input.fileName}:${input.content}`)
      .digest('hex');


    const existing = await DocumentRecord.findOne({
      organisationId: req.demoUser.organisationId,
      uploadFingerprint
    });

    if (existing) {
      res.status(200).json({ item: existing.toObject() });
      return;
    }

    const record = await DocumentRecord.create({
      organisationId: req.demoUser.organisationId,
      uploadedBy: req.demoUser.id,
      fileName: input.fileName,
      sourceText: input.content,
      uploadFingerprint,
      status: 'queued',
      attempt: 1
    });

    await enqueueProcessing({
      documentId: String(record._id),
      organisationId: record.organisationId,
      attempt: record.attempt,
      fileName: record.fileName,
      sourceText: record.sourceText
    });

    res.status(202).json({ item: record.toObject() });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }

    const item = await DocumentRecord.findOne({ _id: req.params.id, organisationId: req.demoUser.organisationId })
      .select('-sourceText')
      .lean();

    if (!item) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    res.json({ item });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/retry', async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }

    const item = await DocumentRecord.findOneAndUpdate(
      { _id: req.params.id, organisationId: req.demoUser.organisationId },
      { $inc: { attempt: 1 }, $set: { status: 'queued', errorMessage: null } },
      { new: true }
    );

    if (!item) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    await enqueueProcessing({
      documentId: String(item._id),
      organisationId: item.organisationId,
      attempt: item.attempt,
      fileName: item.fileName,
      sourceText: item.sourceText
    });

    res.status(202).json({ item: item.toObject() });
  } catch (error) {
    next(error);
  }
});

export default router;

import { z } from 'zod';
const text = (max) => z.string().trim().min(1).max(max);
// PATCH must preserve absent fields. Zod 4 otherwise applies defaults inside optional fields.
const updateFields = (schema) =>
  z
    .object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [
          key,
          field instanceof z.ZodDefault ? field.removeDefault() : field,
        ]),
      ),
    )
    .partial();
export const uuid = z.string().uuid();
export const cents = z.number().int().min(0).max(100000000000);
export const positiveCents = cents.refine(
  (value) => value > 0,
  'Amount must be greater than zero.',
);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  )
  .nullable();
export const roles = z.enum(['owner', 'admin', 'member', 'viewer']);
export const authInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
});
export const registerInput = authInput.extend({
  name: text(80),
  inviteToken: z.string().max(200).optional(),
});
export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
export const workspaceInput = z.object({ name: text(100), sample: z.boolean().default(false) });
export const invitationInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
export const allocationInput = z.array(z.object({ name: text(60), amountCents: cents })).max(30);
export const projectFields = z.object({
  name: text(140),
  description: z.string().trim().max(2000).default(''),
  goal: z.string().trim().max(3000).default(''),
  status: z.enum(['planned', 'active', 'paused', 'done']).default('active'),
  currency: z.enum(['USD', 'EUR', 'GBP', 'CAD', 'AUD']).default('USD'),
  budgetCents: cents.default(0),
  dueDate: date.default(null),
  allocations: allocationInput.default([]),
});
export const projectUpdate = updateFields(projectFields).extend({
  version: z.number().int().positive(),
  archived: z.boolean().optional(),
});
export const taskFields = z.object({
  title: text(200),
  description: z.string().trim().max(10000).default(''),
  status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
  assigneeId: uuid.nullable().default(null),
  dueDate: date.default(null),
});
export const taskUpdate = updateFields(taskFields).extend({
  version: z.number().int().positive(),
  archived: z.boolean().optional(),
});
export const documentFields = z.object({
  title: text(200),
  body: z.string().max(200000).default(''),
});
export const documentUpdate = updateFields(documentFields).extend({
  version: z.number().int().positive(),
  archived: z.boolean().optional(),
});
export const requestInput = z.object({
  projectId: uuid,
  taskId: uuid.nullable().default(null),
  title: text(200),
  reason: text(5000),
  amountCents: positiveCents,
  category: text(60),
  approverId: uuid,
});
export const requestAction = z.object({
  action: z.enum(['approve', 'decline', 'pay', 'cancel']),
  version: z.number().int().positive(),
  reason: z.string().trim().max(2000).optional(),
  paidOn: date.optional(),
  note: z.string().trim().max(2000).optional(),
});
export const expenseInput = z.object({
  projectId: uuid,
  title: text(200),
  amountCents: positiveCents,
  category: text(60),
  paidOn: date.refine((value) => value !== null),
  note: z.string().trim().max(2000).default(''),
});
export const commentInput = z.object({
  entityType: z.enum(['task', 'document', 'request']),
  entityId: uuid,
  body: text(5000),
});

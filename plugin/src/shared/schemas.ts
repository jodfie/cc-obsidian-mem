import { z } from 'zod';

/**
 * Zod schemas for AI output validation
 * Used by background-summarize.ts to validate and parse AI-generated knowledge
 */

/**
 * Schema for a single knowledge item
 */
export const KnowledgeItemSchema = z.object({
  type: z.enum(['qa', 'explanation', 'decision', 'research', 'learning']),
  title: z.string().min(5).max(100),
  context: z.string().min(10).max(200),
  summary: z.string().min(20).max(500),
  keyPoints: z.array(z.string()).min(1).max(10),
  topics: z.array(z.string()).min(1).max(10),
  relevance: z.enum(['project', 'skip']).optional(),
  files_referenced: z.array(z.string()).optional(),
});

/**
 * Parsed knowledge item type (inferred from schema)
 */
export type KnowledgeItemParsed = z.infer<typeof KnowledgeItemSchema>;

/**
 * Schema for the complete extraction result
 */
export const ExtractionResultSchema = z.object({
  knowledge: z.array(KnowledgeItemSchema),
  session_summary: z.string().optional(),
  primary_topics: z.array(z.string()).optional(),
});

/**
 * Extraction result type (inferred from schema)
 */
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

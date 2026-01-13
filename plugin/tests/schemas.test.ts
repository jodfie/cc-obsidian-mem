import { describe, test, expect } from 'bun:test';
import { KnowledgeItemSchema, ExtractionResultSchema } from '../src/shared/schemas.js';

describe('KnowledgeItemSchema', () => {
  test('validates valid knowledge item', () => {
    const validItem = {
      type: 'qa',
      title: 'How to configure authentication',
      context: 'When setting up user authentication in the app',
      summary: 'The authentication system uses JWT tokens stored in HTTP-only cookies for security.',
      keyPoints: ['Use JWT tokens', 'Store in HTTP-only cookies'],
      topics: ['authentication', 'security'],
      relevance: 'project',
    };

    const result = KnowledgeItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });

  test('validates with optional files_referenced', () => {
    const itemWithFiles = {
      type: 'decision',
      title: 'Use Redux for state management',
      context: 'When managing complex app state',
      summary: 'Decided to use Redux Toolkit for state management due to its simplicity.',
      keyPoints: ['Use Redux Toolkit', 'Centralized state'],
      topics: ['state-management', 'redux'],
      files_referenced: ['src/store/index.ts', 'src/store/userSlice.ts'],
      relevance: 'project',
    };

    const result = KnowledgeItemSchema.safeParse(itemWithFiles);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files_referenced).toEqual(['src/store/index.ts', 'src/store/userSlice.ts']);
    }
  });

  test('rejects invalid type', () => {
    const invalidItem = {
      type: 'invalid-type',
      title: 'Some title here',
      context: 'Some context here',
      summary: 'Some summary text that is long enough',
      keyPoints: ['Point 1'],
      topics: ['topic1'],
    };

    const result = KnowledgeItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });

  test('rejects title too short', () => {
    const invalidItem = {
      type: 'qa',
      title: 'Hi', // Too short (< 5 chars)
      context: 'Some context here',
      summary: 'Some summary text that is long enough',
      keyPoints: ['Point 1'],
      topics: ['topic1'],
    };

    const result = KnowledgeItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });

  test('rejects empty keyPoints array', () => {
    const invalidItem = {
      type: 'qa',
      title: 'Valid title here',
      context: 'Some context here',
      summary: 'Some summary text that is long enough',
      keyPoints: [], // Empty array
      topics: ['topic1'],
    };

    const result = KnowledgeItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });

  test('rejects invalid relevance value', () => {
    const invalidItem = {
      type: 'qa',
      title: 'Valid title here',
      context: 'Some context here',
      summary: 'Some summary text that is long enough',
      keyPoints: ['Point 1'],
      topics: ['topic1'],
      relevance: 'invalid', // Should be 'project' or 'skip'
    };

    const result = KnowledgeItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });
});

describe('ExtractionResultSchema', () => {
  test('validates array of knowledge items', () => {
    const validResult = {
      knowledge: [
        {
          type: 'qa',
          title: 'How to configure authentication',
          context: 'When setting up user authentication',
          summary: 'The authentication system uses JWT tokens stored in cookies.',
          keyPoints: ['Use JWT tokens', 'Store in cookies'],
          topics: ['authentication', 'security'],
          relevance: 'project',
        },
        {
          type: 'decision',
          title: 'Database choice decision',
          context: 'When selecting a database for the project',
          summary: 'Chose PostgreSQL for its reliability and features.',
          keyPoints: ['Use PostgreSQL', 'JSON support is useful'],
          topics: ['database', 'postgresql'],
          relevance: 'project',
        },
      ],
    };

    const result = ExtractionResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge.length).toBe(2);
    }
  });

  test('validates with optional session_summary', () => {
    const resultWithSummary = {
      knowledge: [
        {
          type: 'learning',
          title: 'Learned about async patterns',
          context: 'When debugging async issues',
          summary: 'Async/await patterns help avoid callback hell.',
          keyPoints: ['Use async/await', 'Handle errors with try-catch'],
          topics: ['async', 'javascript'],
          relevance: 'project',
        },
      ],
      session_summary: 'This session focused on async debugging and patterns.',
      primary_topics: ['async', 'debugging'],
    };

    const result = ExtractionResultSchema.safeParse(resultWithSummary);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_summary).toBe('This session focused on async debugging and patterns.');
      expect(result.data.primary_topics).toEqual(['async', 'debugging']);
    }
  });

  test('validates empty knowledge array', () => {
    const emptyResult = {
      knowledge: [],
    };

    const result = ExtractionResultSchema.safeParse(emptyResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge.length).toBe(0);
    }
  });
});

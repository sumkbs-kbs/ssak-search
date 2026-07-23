export { AnswerClient, AnswerApiError } from './client.js'
export { parseSSEStream } from './stream.js'
export type {
  // Request types
  SearchRequest,
  SearchDepth,
  Topic,
  TimeRange,
  SortBy,
  ExtractRequest,
  // Response types
  SearchResponse,
  SearchResult,
  SearchAnswer,
  ExtractResponse,
  ExtractedContent,
  ErrorResponse,
  // Stream types
  StreamEvent,
  StreamEventResults,
  StreamEventToken,
  StreamEventAnswerDone,
  StreamEventDone,
  StreamEventError,
  // Options
  ClientOptions,
} from './types.js'

declare module 'ollama' {
  interface OllamaEmbeddingsOptions {
    model: string
    prompt: string
  }

  interface OllamaEmbeddingResult {
    embedding: number[]
  }

  interface OllamaClient {
    embeddings(options: OllamaEmbeddingsOptions): Promise<OllamaEmbeddingResult>
  }

  const ollama: OllamaClient
  export default ollama
}

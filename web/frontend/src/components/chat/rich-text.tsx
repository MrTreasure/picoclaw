import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { MarkdownCodeBlock } from "./message-code-block"
import { MessageImage } from "./message-image"

export default function RichText({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
      components={{ pre: MarkdownCodeBlock, img: MessageImage }}
    >
      {content}
    </ReactMarkdown>
  )
}

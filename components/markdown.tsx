'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { memo } from 'react'

// Model text can name any image URL, and loading one sends that URL to its host.
const NO_IMAGES = { img: () => null }

export default memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={NO_IMAGES}>{children}</ReactMarkdown>
    </div>
  )
})

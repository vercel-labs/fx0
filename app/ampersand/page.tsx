import type { Metadata } from 'next'
import CollabApp from '../../components/collab-app'

export const metadata: Metadata = {
  description: 'A shared fx0 design workspace powered by Ampersand.',
  robots: { index: false, follow: false },
}

export default function CollabPage() {
  return <CollabApp />
}

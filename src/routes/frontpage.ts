import { ageString, fetchFrontPage } from '../hn'
import { jsonResponse } from '../http'

export async function handleFrontPage(): Promise<Response> {
  try {
    const items = await fetchFrontPage() as unknown as Array<Record<string, unknown>>
    const result = items.slice(0, 10).map(item => ({
      // Algolia's search endpoint keys the id as `objectID` (string).
      id: String(item.objectID ?? item.id ?? ''),
      title: item.title,
      url: item.url,
      points: item.points ?? 0,
      comments: item.num_comments ?? (Array.isArray(item.children) ? item.children.length : 0),
      age: ageString(String(item.created_at ?? '')),
    })).filter(item => item.id && item.title)
    return jsonResponse(result)
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500)
  }
}

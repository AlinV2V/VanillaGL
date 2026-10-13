export async function checkedModelJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

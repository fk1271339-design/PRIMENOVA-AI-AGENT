import fs from 'node:fs/promises';
import path from 'node:path';

export async function readFileContent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }
}

export async function createOrUpdateFile(filePath: string, content: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to write file ${filePath}: ${error.message}`);
  }
}

export async function listDirectoryRecursive(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }
        const subFiles = await listDirectoryRecursive(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }
    return files;
  } catch (error: any) {
    throw new Error(`Failed to list directory ${dirPath}: ${error.message}`);
  }
}

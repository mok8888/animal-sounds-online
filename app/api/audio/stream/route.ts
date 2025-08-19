import { NextRequest, NextResponse } from 'next/server';
import { audioStorage } from '@/services/audio-storage';
import { getURL } from '@/utils/helper';
import { db } from '@/lib/db/connection';
import { animalSounds } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import 'dotenv/config';

// 速率限制映射（简单内存存储，生产环境建议使用Redis）
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// 清理过期的速率限制记录
function cleanupRateLimit() {
    const now = Date.now();
    for (const [key, value] of rateLimitMap.entries()) {
        if (now > value.resetTime) {
            rateLimitMap.delete(key);
        }
    }
}

// 检查速率限制
function checkRateLimit(identifier: string): boolean {
    cleanupRateLimit();

    const now = Date.now();
    const windowMs = 60 * 1000; // 1分钟窗口
    const maxRequests = 30; // 每分钟最多30次请求

    const current = rateLimitMap.get(identifier);

    if (!current) {
        rateLimitMap.set(identifier, { count: 1, resetTime: now + windowMs });
        return true;
    }

    if (now > current.resetTime) {
        rateLimitMap.set(identifier, { count: 1, resetTime: now + windowMs });
        return true;
    }

    if (current.count >= maxRequests) {
        return false;
    }

    current.count++;
    return true;
}

// 解析Range头部
function parseRange(range: string, fileSize: number): { start: number; end: number } | null {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return null;

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
        return null;
    }

    return { start, end };
}

// 智能Range优化：为首次请求或小请求提供优化的范围
function optimizeRange(requestedRange: { start: number; end: number }, fileSize: number, isFirstRequest: boolean): { start: number; end: number } {
    if (isFirstRequest && requestedRange.start === 0) {
        // 首次请求：根据文件大小优化初始块大小
        let initialPlaybackSize: number;

        if (fileSize < 5 * 1024 * 1024) { // < 5MB
            initialPlaybackSize = Math.min(1024 * 1024, fileSize - 1); // 1MB
        } else if (fileSize < 15 * 1024 * 1024) { // < 15MB
            initialPlaybackSize = Math.min(2 * 1024 * 1024, fileSize - 1); // 2MB
        } else { // >= 15MB
            initialPlaybackSize = Math.min(3 * 1024 * 1024, fileSize - 1); // 3MB
        }

        return {
            start: 0,
            end: initialPlaybackSize
        };
    }

    // 根据文件大小调整块大小
    const requestedSize = requestedRange.end - requestedRange.start + 1;
    let optimalChunkSize: number;

    if (fileSize < 5 * 1024 * 1024) { // < 5MB
        optimalChunkSize = 512 * 1024; // 512KB
    } else if (fileSize < 15 * 1024 * 1024) { // < 15MB
        optimalChunkSize = 1024 * 1024; // 1MB
    } else { // >= 15MB
        optimalChunkSize = 1536 * 1024; // 1.5MB
    }

    // 如果请求的块太小，扩展到优化大小
    if (requestedSize < optimalChunkSize && requestedRange.end < fileSize - 1) {
        const newEnd = Math.min(requestedRange.start + optimalChunkSize - 1, fileSize - 1);
        return {
            start: requestedRange.start,
            end: newEnd
        };
    }

    return requestedRange;
}


export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const fileName = searchParams.get('file');
        const token = searchParams.get('token');
        const expires = searchParams.get('expires');
        console.log('audio stream fileName', fileName);

        // 基础参数验证
        if (!fileName) {
            return NextResponse.json(
                { error: 'Missing file parameter' },
                { status: 400 }
            );
        }


        // 先获取文件元数据来确定文件大小
        const fileMetadata = await audioStorage.getfileMediaInfo(fileName);
        if (!fileMetadata?.ContentLength) {
            return NextResponse.json(
                { error: 'Unable to determine file size' },
                { status: 500 }
            );
        }

        const fileSize = fileMetadata.ContentLength;
        const range = request.headers.get('range');
        let start = 0;
        let end = fileSize - 1;
        let isPartialContent = false;
        let isFirstRequest = false;
        console.log('audio stream range', range);
        if (range) {

            // 解析Range请求
            const parsedRange = parseRange(range, fileSize);
            console.log('audio stream parsedRange', parsedRange);
            if (!parsedRange) {
                return new NextResponse('Invalid range', { status: 416 });
            }

            start = parsedRange.start;
            end = parsedRange.end;
            isPartialContent = true;
            isFirstRequest = start === 0;

            // 应用智能分块优化
            const optimizedRange = optimizeRange({ start, end }, fileSize, isFirstRequest);
            start = optimizedRange.start;
            end = optimizedRange.end;

            console.log(`Optimized range: ${start}-${end} (original: ${parsedRange.start}-${parsedRange.end})`);
        } else {
            // 没有Range头的首次请求，使用智能初始块策略
            isFirstRequest = true;
            const optimizedRange = optimizeRange({ start: 0, end: fileSize - 1 }, fileSize, true);
            start = optimizedRange.start;
            end = optimizedRange.end;
            isPartialContent = end < fileSize - 1;

            console.log(`First request optimized to: ${start}-${end} of ${fileSize}`);
        }

        // 使用Range参数获取文件片段
        const response = await audioStorage.getFileRange(fileName, start, end);

        if (!response?.Body) {
            return NextResponse.json(
                { error: 'Audio file not found' },
                { status: 404 }
            );
        }

        const contentLength = end - start + 1;
        const contentRange = `bytes ${start}-${end}/${fileSize}`;
        console.log('audio stream contentRange', contentRange);

        // 确定音频内容类型
        let contentType = response.ContentType || 'audio/mpeg';
        const ext = fileName.split('.').pop()?.toLowerCase();
        const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            flac: 'audio/flac',
            m4a: 'audio/mp4',
        };
        if (ext && mimeTypes[ext]) {
            contentType = mimeTypes[ext];
        }

        // 根据文件大小和请求类型优化缓存策略
        let cacheControl: string;
        if (isFirstRequest && fileSize > 10 * 1024 * 1024) {
            // 大文件的首次请求块，较短缓存时间以支持快速更新
            cacheControl = 'public, max-age=7200, stale-while-revalidate=3600';
        } else if (isPartialContent) {
            // 部分内容请求，长时间缓存
            cacheControl = 'public, max-age=31536000, immutable';
        } else {
            // 小文件完整请求
            cacheControl = 'public, max-age=86400, stale-while-revalidate=3600';
        }

        // 构建响应头
        const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Content-Length': contentLength.toString(),
            'Accept-Ranges': 'bytes',
            'Cache-Control': cacheControl,
            'Access-Control-Allow-Origin': getURL() || '*',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Disposition': 'inline',
        };

        // 添加预取提示头部，帮助客户端预加载下一块
        if (isPartialContent && end < fileSize - 1) {
            const nextChunkStart = end + 1;
            const nextChunkEnd = Math.min(nextChunkStart + contentLength - 1, fileSize - 1);
            headers['Link'] = `</api/audio/stream?file=${encodeURIComponent(fileName)}>; rel=prefetch; as=audio`;
            headers['X-Next-Range'] = `bytes=${nextChunkStart}-${nextChunkEnd}`;
        }

        if (isPartialContent) {
            headers['Content-Range'] = contentRange;
        }

        return new NextResponse(response.Body.transformToWebStream(), {
            status: isPartialContent ? 206 : 200,
            headers
        });


    } catch (error) {
        console.error('Audio stream error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

// 支持CORS预检请求
export async function OPTIONS(request: NextRequest) {
    return new NextResponse(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': getURL() || '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Range',
            'Access-Control-Max-Age': '86400',
        },
    });
} 

import { NextRequest, NextResponse } from 'next/server';
import { audioStorageR2 } from '@/services/audio-storage';
import { getURL } from '@/utils/helper';
import { eq } from 'drizzle-orm';
import 'dotenv/config';

// Parsing the Range header
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

// Smart Range Optimization: Provides an optimized range for first requests or small requests
function optimizeRange(requestedRange: { start: number; end: number }, fileSize: number, isFirstRequest: boolean): { start: number; end: number } {
    if (isFirstRequest && requestedRange.start === 0) {
        // First request: Optimize initial chunk size based on file size
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

    // Adjust block size based on file size
    const requestedSize = requestedRange.end - requestedRange.start + 1;
    let optimalChunkSize: number;

    if (fileSize < 5 * 1024 * 1024) { // < 5MB
        optimalChunkSize = 512 * 1024; // 512KB
    } else if (fileSize < 15 * 1024 * 1024) { // < 15MB
        optimalChunkSize = 1024 * 1024; // 1MB
    } else { // >= 15MB
        optimalChunkSize = 1536 * 1024; // 1.5MB
    }

    // If the requested block is too small, expand to the optimal size
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

        // Basic parameter verification
        if (!fileName) {
            return NextResponse.json(
                { error: 'Missing file parameter' },
                { status: 400 }
            );
        }


        // First get the file metadata to determine the file size
        const fileMetadata = await audioStorageR2.getfileMediaInfo(fileName);
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
            // Parsing Range Requests
            const parsedRange = parseRange(range, fileSize);
            console.log('audio stream parsedRange', parsedRange);
            if (!parsedRange) {
                return new NextResponse('Invalid range', { status: 416 });
            }

            start = parsedRange.start;
            end = parsedRange.end;
            isPartialContent = true;
            isFirstRequest = start === 0;

            // Apply intelligent block optimization
            const optimizedRange = optimizeRange({ start, end }, fileSize, isFirstRequest);
            start = optimizedRange.start;
            end = optimizedRange.end;

            console.log(`Optimized range: ${start}-${end} (original: ${parsedRange.start}-${parsedRange.end})`);
        } else {
            // For the first request without a Range header, use the smart initial block strategy.
            isFirstRequest = true;
            const optimizedRange = optimizeRange({ start: 0, end: fileSize - 1 }, fileSize, true);
            start = optimizedRange.start;
            end = optimizedRange.end;
            isPartialContent = end < fileSize - 1;

            console.log(`First request optimized to: ${start}-${end} of ${fileSize}`);
        }

        // Use the Range parameter to get a file segment
        const response = await audioStorageR2.getFileRange(fileName, start, end);

        if (!response?.Body) {
            return NextResponse.json(
                { error: 'Audio file not found' },
                { status: 404 }
            );
        }

        const contentLength = end - start + 1;
        const contentRange = `bytes ${start}-${end}/${fileSize}`;
        console.log('audio stream contentRange', contentRange);

        // Determine the audio content type
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

        // Optimize caching strategy based on file size and request type
        let cacheControl: string;
        if (isFirstRequest && fileSize > 10 * 1024 * 1024) {
            // First request chunks for large files, with shorter cache times to support fast updates
            cacheControl = 'public, max-age=7200, stale-while-revalidate=3600';
        } else if (isPartialContent) {
            // Partial content request, long-term cache
            cacheControl = 'public, max-age=31536000, immutable';
        } else {
            // Small file complete request
            cacheControl = 'public, max-age=86400, stale-while-revalidate=3600';
        }

        // Constructing the response header
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

        // Add a prefetch hint header to help the client preload the next block
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

// Support CORS preflight requests
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

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl as getSignedUrlPresigner } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

interface AudioUploadResult {
    success: boolean;
    audioUrl?: string;
    fileName?: string;
    error?: string;
}

interface SignedUrlResult {
    success: boolean;
    signedUrl?: string;
    error?: string;
}

export class AudioStorageR2Service {
    private s3Client: S3Client;
    private bucketName: string;

    constructor() {
        // Verify required environment variables
        const accountId = process.env.R2_ACCOUNT_ID;
        const accessKeyId = process.env.R2_ACCESS_KEY_ID;
        const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

        if (!accountId || !accessKeyId || !secretAccessKey) {
            throw new Error('Missing required R2 environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
        }

        // Building the correct endpoint
        const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

        console.log('R2 Configuration:', {
            accountId: accountId.substring(0, 8) + '...',
            endpoint,
            bucketName: process.env.R2_BUCKET_NAME || 'audio-files'
        });

        // Initialize the S3 client and configure it for Cloudflare R2
        this.s3Client = new S3Client({
            region: 'auto', 
            endpoint,
            credentials: {
                accessKeyId,
                secretAccessKey,
            },
            forcePathStyle: true,
        });

        this.bucketName = 'audio-files';
    }


    /**
     * Check if the audio file exists
     */
    async getfileMediaInfo(fileName: string): Promise<GetObjectCommandOutput | null> {
        try {
            const headCommand = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: fileName,
            });

            const res = await this.s3Client.send(headCommand);
            return res;

        } catch (error: any) {
            console.error('R2 file media info error:', error);
            return null;
        }
    }

    /**
     * Get the specified byte range of a file
     */
    async getFileRange(fileName: string, start: number, end: number): Promise<GetObjectCommandOutput | null> {
        try {
            const rangeCommand = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: fileName,
                Range: `bytes=${start}-${end}`,
            });

            const res = await this.s3Client.send(rangeCommand);
            return res;

        } catch (error: any) {
            console.error('R2 file range error:', error);
            return null;
        }
    }
}

export const audioStorageR2 = new AudioStorageR2Service();

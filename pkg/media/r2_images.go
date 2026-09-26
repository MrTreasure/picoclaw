package media

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ImagePublisher stores selected chat images at a public HTTPS origin.
type ImagePublisher interface {
	Put(context.Context, string, string, string) error
	Delete(context.Context, string) error
	URL(string) string
}

type R2ImagePublisher struct {
	client  *s3.Client
	bucket  string
	baseURL string
}

// NewR2ImagePublisherFromEnv uses a configured R2 bucket and public custom domain.
// The S3 credentials may come from an existing EnvironmentFile; they are never
// exposed to the browser or written to the chat transcript.
func NewR2ImagePublisherFromEnv() (*R2ImagePublisher, error) {
	bucket := strings.TrimSpace(os.Getenv("PICOCLAW_IMAGE_R2_BUCKET"))
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("PICOCLAW_IMAGE_PUBLIC_BASE_URL")), "/")
	if bucket == "" && baseURL == "" {
		return nil, nil
	}
	endpoint := strings.TrimSpace(os.Getenv("R2_ENDPOINT"))
	accessKey := strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY"))
	if bucket == "" || !strings.HasPrefix(baseURL, "https://") || endpoint == "" || accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("public image R2 configuration is incomplete")
	}
	client := s3.New(s3.Options{
		Region: "auto", BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		UsePathStyle: true, RetryMaxAttempts: 2,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
	})
	return &R2ImagePublisher{client: client, bucket: bucket, baseURL: baseURL}, nil
}

func (p *R2ImagePublisher) Put(ctx context.Context, key, localPath, contentType string) error {
	file, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	_, err = p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(p.bucket), Key: aws.String(key), Body: file,
		ContentLength: aws.Int64(info.Size()), ContentType: aws.String(contentType),
		CacheControl: aws.String("no-store"),
	})
	if err != nil {
		return fmt.Errorf("upload image to R2: %w", err)
	}
	return nil
}

func (p *R2ImagePublisher) Delete(ctx context.Context, key string) error {
	_, err := p.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(p.bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("delete R2 image: %w", err)
	}
	return nil
}

func (p *R2ImagePublisher) URL(key string) string {
	return p.baseURL + "/" + strings.TrimLeft(filepath.ToSlash(key), "/")
}

// Sweep removes images left behind by a process exit before local TTL cleanup.
// It only touches the dedicated Muse image prefix.
func (p *R2ImagePublisher) Sweep(ctx context.Context, olderThan time.Time) error {
	paginator := s3.NewListObjectsV2Paginator(p.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(p.bucket), Prefix: aws.String("muse-chat/"),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list expired R2 images: %w", err)
		}
		for _, object := range page.Contents {
			if object.Key == nil || object.LastModified == nil || !object.LastModified.Before(olderThan) {
				continue
			}
			if err := p.Delete(ctx, *object.Key); err != nil {
				return err
			}
		}
	}
	return nil
}

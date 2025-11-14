package memory

import (
	"context"
	"time"
)

type MemoryStore interface {
	CreateMemory(ctx context.Context, memory Memory) error
	GetMemory(ctx context.Context, id string) (Memory, error)
	ListMemories(ctx context.Context, filter MemoryFilter) ([]Memory, error)
	DeleteMemory(ctx context.Context, id string) error
	SearchByEmbedding(ctx context.Context, embedding []float64, opts SearchOptions) ([]Memory, error)
}

type SearchOptions struct {
}

type MemoryFilter struct {
}

type Entry struct {
	ID         string
	Type       string
	Content    interface{}
	Metadata   map[string]interface{}
	Timestamp  time.Time
	Importance float64
	Tags       []string
}

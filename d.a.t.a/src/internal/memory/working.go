// internal/memory/working.go
package memory

import (
	"container/ring"
	"context"
	"sync"
)

type workingMemoryImpl struct {
	buffer *ring.Ring
	size   int
	mu     sync.RWMutex
}

// func NewWorkingMemory(size int) WorkingMemory {
// 	return &workingMemoryImpl{
// 		buffer: ring.New(size),
// 		size:   size,
// 	}
// }

func (w *workingMemoryImpl) Add(ctx context.Context, entry Entry) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.buffer.Value = entry
	w.buffer = w.buffer.Next()
	return nil
}

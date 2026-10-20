//! Row-parallel helpers. With the `parallel` feature (default) rows run on rayon's pool. Each row is
//! computed independently from read-only inputs, so the output is bit-identical with or without it.

#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// Call `f(row_index, row)` for every `row_len`-sized chunk of `buf`.
pub fn for_each_row_mut<T, F>(buf: &mut [T], row_len: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync + Send,
{
    if row_len == 0 || buf.is_empty() {
        return;
    }
    #[cfg(feature = "parallel")]
    buf.par_chunks_mut(row_len)
        .enumerate()
        .for_each(|(y, row)| f(y, row));
    #[cfg(not(feature = "parallel"))]
    buf.chunks_mut(row_len)
        .enumerate()
        .for_each(|(y, row)| f(y, row));
}

/// Number of worker threads used by [`for_each_row_mut`].
pub fn threads() -> usize {
    #[cfg(feature = "parallel")]
    {
        rayon::current_num_threads()
    }
    #[cfg(not(feature = "parallel"))]
    {
        1
    }
}

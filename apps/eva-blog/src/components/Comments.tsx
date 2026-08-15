import { useLocale } from "../hooks/useLocale";
import { EmptyState } from "./EmptyState";
import type { PublicArticle, Comment } from "../types";

interface CommentsProps {
  article: PublicArticle;
  comments: Comment[];
  loading: boolean;
  onSubmit: (body: string) => Promise<void>;
}

export function Comments({ article, comments, loading, onSubmit }: CommentsProps) {
  const { t, formatDate } = useLocale();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get("body") as string;
    await onSubmit(body);
    // 与旧版一致：提交后（成功或失败）重渲染都会清空输入框。
    event.currentTarget.reset();
  };

  return (
    <section className="comments-section">
      <div className="section-title">
        <div>
          <p className="eyebrow">{t("comments.kicker")}</p>
          <h2>{t("comments.title")}</h2>
        </div>
        <span>{comments.length}</span>
      </div>
      <div className="comment-list">
        {loading ? (
          <EmptyState text={t("comments.loading")} />
        ) : comments.length ? (
          comments.map((comment) => (
            <article className="comment" key={comment.id}>
              <img src={comment.author.avatarUrl} alt="" loading="lazy" />
              <div>
                <strong>@{comment.author.login}</strong>
                <small>{formatDate(comment.createdAt)}</small>
                <p>{comment.body}</p>
              </div>
            </article>
          ))
        ) : (
          <EmptyState text={t("comments.empty")} />
        )}
      </div>
      <form className="comment-form" onSubmit={handleSubmit}>
        <textarea name="body" rows={4} placeholder={t("comments.placeholder")} required />
        <button type="submit">{t("comments.post")}</button>
      </form>
    </section>
  );
}

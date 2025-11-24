---
layout: default
title: Blog
permalink: /blog/
---

<div class="post-list">

  {% for post in site.posts %}
    <div class="post-item">
      <div class="post-meta">
        Daking Rai - {{ post.date | date: "%-m/%-d/%y" }}
      </div>

      <a class="post-link" href="{{ post.url | relative_url }}">
        {{ post.title }}
      </a>
    </div>
  {% endfor %}

</div>
const followButton = document.getElementById("follow");
const followerCount = document.getElementById("followers");

let followers = 0;
let following = false;

followButton.addEventListener("click", function () {
  following = !following;

  if (following) {
    followers = followers + 1;
    followButton.textContent = "Following";
  } else {
    followers = followers - 1;
    followButton.textContent = "Follow";
  }

  followerCount.textContent = followers;
  console.log("followers is now", followers);
});
